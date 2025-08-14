import { URL } from 'url';
import { BrowserContext, Page } from 'playwright';
import { BrowserManager } from './browser-manager';
import { ProxyManager } from './proxy-manager';
import { ScrapeRequest, ScrapeResult, ProxyEndpoint } from '../../shared/types';

export class Scraper {
  private browserManager: BrowserManager;
  private proxyManager: ProxyManager;
  private workerId: string;

  constructor(browserManager: BrowserManager, proxyManager: ProxyManager, workerId: string) {
    this.browserManager = browserManager;
    this.proxyManager = proxyManager;
    this.workerId = workerId;
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    const startTime = Date.now();
    let attempt = 1;
    let lastError: Error | null = null;
    let bytesReceived = 0;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let proxyUsed: ProxyEndpoint | null = null;

    const maxRetries = 3;
    const timeout = request.max_wait_ms || 12000;

    // Validate URL
    try {
      new URL(request.url);
    } catch {
      throw new Error('INVALID_URL: Malformed URL');
    }

    for (attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🎯 Attempt ${attempt}/${maxRetries}: ${request.url}`);

        // Get proxy for this attempt
        proxyUsed = this.proxyManager.getProxy(attempt);
        const proxyUrl = this.proxyManager.formatProxyUrl(proxyUsed);
        
        // Get user agent
        const userAgent = request.user_agent === 'auto' ? undefined : request.user_agent;

        // Create browser context
        context = await this.browserManager.createContext(proxyUrl, userAgent);
        page = await this.browserManager.createPage(context, request.block_assets);

        // Set timeout
        page.setDefaultTimeout(timeout);
        page.setDefaultNavigationTimeout(timeout);

        // Track response size
        let responseSize = 0;
        page.on('response', (response) => {
          const contentLength = response.headers()['content-length'];
          if (contentLength) {
            responseSize += parseInt(contentLength, 10) || 0;
          }
        });

        // Navigate to URL with appropriate wait strategy
        const waitUntil = request.render_js ? 'networkidle' : 'domcontentloaded';
        const response = await page.goto(request.url, { 
          waitUntil,
          timeout
        });

        if (!response) {
          throw new Error('NETWORK: No response received');
        }

        const statusCode = response.status();
        const finalUrl = response.url();

        // Check for blocking status codes
        if ([403, 429, 503].includes(statusCode)) {
          throw new Error(`BLOCKED: HTTP ${statusCode}`);
        }

        if (statusCode >= 400) {
          throw new Error(`NETWORK: HTTP ${statusCode}`);
        }

        // Wait additional time for JS rendering if requested
        if (request.render_js) {
          await page.waitForTimeout(Math.min(3000, timeout / 4));
        }

        // Extract data
        const title = await page.title().catch(() => '');
        const html = await page.content();
        const headers = response.headers();

        bytesReceived = responseSize || html.length;

        // Extract clean text content
        const cleanText = await this.extractCleanText(page, html);
        
        // Extract PDF URLs
        const pdfUrls = this.extractPdfUrls(html, finalUrl);

        // Mark proxy success
        this.proxyManager.markSuccess(proxyUsed, Date.now() - startTime);

        // Prepare result with text extraction options
        const result: ScrapeResult = {
          url: request.url,
          final_url: finalUrl,
          status_code: statusCode,
          title,
          headers,
          html_body: request.extract_text ? cleanText : html, // Return clean text or full HTML
          text_content: cleanText, // Always include clean text
          pdf_urls: pdfUrls,
          meta: {
            fetch_ms: Date.now() - startTime,
            retries: attempt - 1,
            proxy_used: `${proxyUsed.host}:${proxyUsed.port}`,
            render_js: request.render_js || false,
            bytes_rx: bytesReceived,
            worker_id: this.workerId,
            content_size: request.extract_text ? cleanText.length : html.length
          }
        };

        console.log(`✅ Success: ${request.url} (${html.length} chars, ${result.meta.fetch_ms}ms)`);
        return result;

      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message;
        
        // Mark proxy failure if we have one
        if (proxyUsed) {
          this.proxyManager.markFailure(proxyUsed, errorMessage);
        }
        
        console.warn(`⚠️  Attempt ${attempt} failed: ${errorMessage}`);

        // Clean up context and page
        if (page) {
          await page.close().catch(() => {});
          page = null;
        }
        if (context) {
          await context.close().catch(() => {});
          context = null;
        }

        // Determine if we should retry
        const shouldRetry = attempt < maxRetries && 
          (errorMessage.includes('NETWORK') || 
           errorMessage.includes('BLOCKED') || 
           errorMessage.includes('timeout') ||
           errorMessage.includes('TimeoutError'));

        if (!shouldRetry) {
          break;
        }

        // Exponential backoff with jitter
        const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        const jitter = Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
      }
    }

    // All attempts failed
    const errorMessage = lastError?.message || 'Unknown error';
    let errorCode: 'INVALID_URL' | 'NETWORK' | 'TIMEOUT' | 'BLOCKED' | 'INTERNAL' = 'INTERNAL';
    
    if (errorMessage.includes('INVALID_URL')) errorCode = 'INVALID_URL';
    else if (errorMessage.includes('NETWORK')) errorCode = 'NETWORK';
    else if (errorMessage.includes('BLOCKED')) errorCode = 'BLOCKED';
    else if (errorMessage.includes('timeout') || errorMessage.includes('TimeoutError')) errorCode = 'TIMEOUT';

    console.error(`❌ Failed: ${request.url} after ${attempt - 1} attempts: ${errorMessage}`);
    throw new Error(`${errorCode}: ${errorMessage}`);
  }

  private async extractCleanText(page: Page, html: string): Promise<string> {
    // Use robust HTML-based text extraction
    return this.extractTextFromHtml(html);
  }

  private extractTextFromHtml(html: string): string {
    // First, extract navigation text separately
    const navigationText = this.extractNavigationText(html);
    
    // Extract main content areas
    let contentHtml = html;
    
    // Try to find main content sections
    const mainContentRegex = /<(main|article|div[^>]*(?:class|id)="[^"]*(?:content|post|article|entry)[^"]*")[^>]*>([\s\S]*?)<\/\1>/gi;
    let mainMatch = mainContentRegex.exec(html);
    
    if (mainMatch && mainMatch[2].length > 200) {
      contentHtml = mainMatch[2];
    } else {
      // Fallback: extract body content
      const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/gi.exec(html);
      if (bodyMatch) {
        contentHtml = bodyMatch[1];
      }
    }
    
    // Remove unwanted sections (but keep navigation text separate)
    let mainText = contentHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Scripts
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // Styles
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '') // NoScript
      .replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, '') // Remove nav from main content
      .replace(/<div[^>]*(?:class|id)="[^"]*(?:nav|header|footer|sidebar|ad|advertisement|cookie|popup|modal)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '') // Ad/nav divs
      .replace(/<!--[\s\S]*?-->/g, ''); // Comments
    
    // Convert main content to clean text
    mainText = mainText
      .replace(/<\/?(h[1-6]|p|div|li|br|blockquote|pre)\b[^>]*>/gi, '\n') // Block elements -> newlines
      .replace(/<\/?(strong|b|em|i|u|mark)\b[^>]*>/gi, '') // Keep emphasis content, remove tags
      .replace(/<[^>]+>/g, ' ') // All other tags -> spaces
      .replace(/&nbsp;/gi, ' ') // Non-breaking spaces
      .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, ' ') // HTML entities
      .replace(/&#[0-9]+;/g, ' ') // Numeric entities
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/\n\s+/g, '\n') // Clean line starts
      .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
      .trim();
    
    // Combine navigation and main content
    let combinedText = '';
    
    if (navigationText.length > 0) {
      combinedText += `NAVIGATION: ${navigationText}\n\n`;
    }
    
    combinedText += mainText;
    
    // Additional cleanup for common issues
    combinedText = combinedText
      .replace(/^[^\w:]*|[^\w]*$/gm, '') // Remove non-word chars at line start/end (keep colons)
      .replace(/^\s*\n/gm, '') // Remove empty lines
      .replace(/(.)\1{4,}/g, '$1$1$1') // Reduce repeated chars (max 3)
      .trim();
    
    // Ensure minimum content length for validity
    return combinedText.length > 50 ? combinedText : 'Content extraction failed - insufficient text content';
  }

  private extractNavigationText(html: string): string {
    // Extract text from navigation elements
    const navElements = [
      /<nav[^>]*>([\s\S]*?)<\/nav>/gi,
      /<header[^>]*>([\s\S]*?)<\/header>/gi,
      /<div[^>]*(?:class|id)="[^"]*(?:nav|menu|navigation)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
      /<ul[^>]*(?:class|id)="[^"]*(?:nav|menu|navigation)[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi
    ];
    
    let navigationTexts: string[] = [];
    
    for (const regex of navElements) {
      let match;
      while ((match = regex.exec(html)) !== null) {
        let navText = match[1]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove scripts
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // Remove styles
          .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
          .replace(/&nbsp;/gi, ' ') // Non-breaking spaces
          .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, ' ') // HTML entities
          .replace(/\s+/g, ' ') // Collapse whitespace
          .trim();
        
        if (navText.length > 5) { // Only include non-trivial navigation text
          navigationTexts.push(navText);
        }
      }
    }
    
    // Remove duplicates and combine
    const uniqueNavTexts = [...new Set(navigationTexts)];
    return uniqueNavTexts.join(' | ').trim();
  }

  private extractPdfUrls(html: string, baseUrl: string): string[] {
    const pdfRegex = /href=["']([^"']*\.pdf[^"']*)/gi;
    const matches = [];
    let match;
    
    while ((match = pdfRegex.exec(html)) !== null) {
      try {
        const pdfUrl = new URL(match[1], baseUrl).href;
        matches.push(pdfUrl);
      } catch {
        // Skip invalid URLs
      }
    }
    
    return [...new Set(matches)]; // Remove duplicates
  }
}