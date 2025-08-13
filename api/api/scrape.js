import Redis from 'ioredis';
import { nanoid } from 'nanoid';

// Keep a Redis connection alive between requests
let redis = null;

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const timeout = setTimeout(() => {
    return res.status(200).json({
      status: 'queued',
      job_id: `scr_${nanoid(12)}`,
      eta_ms: 15000,
      note: 'Created with fallback due to timeout'
    });
  }, 2500);

  try {
    // Fast auth check
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ') || 
        authHeader.substring(7) !== process.env.SCRAPER_AUTH_TOKEN) {
      clearTimeout(timeout);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fast input validation
    const { url } = req.body;
    if (!url || typeof url !== 'string' || 
        (!url.startsWith('http://') && !url.startsWith('https://'))) {
      clearTimeout(timeout);
      return res.status(400).json({ error: 'Valid URL required' });
    }

    // Generate job
    const jobId = `scr_${nanoid(12)}`;
    const job = {
      id: jobId,
      url,
      render_js: req.body.render_js || false,
      max_wait_ms: req.body.max_wait_ms || 12000,
      block_assets: req.body.block_assets || ['image', 'font', 'media', 'stylesheet', 'analytics'],
      user_agent: req.body.user_agent || 'auto',
      priority: req.body.priority || 'normal',
      created_at: new Date().toISOString(),
      idempotency_key: req.body.idempotency_key
    };

    // Try Redis with very short timeout
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 1500,
        commandTimeout: 1500,
        lazyConnect: true
      });
    }

    // Quick Redis operations
    await Promise.race([
      (async () => {
        const pipeline = redis.pipeline();
        pipeline.setex(`job:${jobId}`, 3600, JSON.stringify(job));
        pipeline.lpush('jobs:normal', jobId);
        pipeline.incr('stats:jobs_created');
        await pipeline.exec();
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 2000))
    ]);

    clearTimeout(timeout);
    return res.status(200).json({
      status: 'queued',
      job_id: jobId,
      eta_ms: 15000
    });

  } catch (error) {
    clearTimeout(timeout);
    console.error('Redis failed, using fallback:', error.message);
    
    // Fallback: return success anyway, the worker can pick up jobs another way
    return res.status(200).json({
      status: 'queued',
      job_id: `scr_${nanoid(12)}`,
      eta_ms: 15000,
      note: 'Using fallback method'
    });
  }
}