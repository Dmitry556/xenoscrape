const express = require('express');
const Redis = require('ioredis');
const { nanoid } = require('nanoid');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Redis connection with connection pooling
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableAutoPipelining: true,
  lazyConnect: true,
  keepAlive: 30000,
  connectTimeout: 10000,
  commandTimeout: 5000,
  family: 4,
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'WebsiteScraper v2 API Running on Google Cloud',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    environment: 'production'
  });
});

app.get('/api/health', async (req, res) => {
  try {
    await redis.ping();
    const stats = await Promise.all([
      redis.get('stats:jobs_created').catch(() => '0'),
      redis.get('stats:jobs_completed').catch(() => '0'),
      redis.get('stats:jobs_failed').catch(() => '0'),
      redis.llen('jobs:normal').catch(() => 0),
      redis.keys('worker:*').then(keys => keys.length).catch(() => 0),
    ]);
    
    const [created, completed, failed, normalQueue, activeWorkers] = stats;
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      redis: 'connected',
      stats: {
        jobs_created: parseInt(created) || 0,
        jobs_completed: parseInt(completed) || 0,
        jobs_failed: parseInt(failed) || 0,
        success_rate: parseInt(created) > 0 ? 
          ((parseInt(completed) / parseInt(created)) * 100).toFixed(1) + '%' : 'N/A',
        queue_length: normalQueue,
        active_workers: activeWorkers
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      redis: 'disconnected'
    });
  }
});

// Scrape endpoint
app.post('/api/scrape', async (req, res) => {
  try {
    // Auth check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || 
        authHeader.substring(7) !== process.env.SCRAPER_AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validate URL
    const { url } = req.body;
    if (!url || typeof url !== 'string' || 
        (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return res.status(400).json({ error: 'Valid URL required' });
    }

    // Create job
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

    // Store job and queue it
    const pipeline = redis.pipeline();
    pipeline.setex(`job:${jobId}`, 3600, JSON.stringify(job));
    pipeline.lpush('jobs:normal', jobId);
    pipeline.incr('stats:jobs_created');
    await pipeline.exec();

    res.json({
      status: 'queued',
      job_id: jobId,
      eta_ms: 15000
    });

  } catch (error) {
    console.error('Scrape API error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Result endpoint
app.get('/api/result', async (req, res) => {
  try {
    const { job_id } = req.query;
    if (!job_id) {
      return res.status(400).json({ error: 'job_id required' });
    }

    // Auth check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || 
        authHeader.substring(7) !== process.env.SCRAPER_AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await redis.get(`result:${job_id}`);
    if (result) {
      const data = JSON.parse(result);
      res.json({
        status: 'done',
        job_id,
        result: data.data
      });
    } else {
      const job = await redis.get(`job:${job_id}`);
      if (job) {
        res.json({
          status: 'processing',
          job_id,
          message: 'Job is being processed'
        });
      } else {
        res.status(404).json({
          status: 'failed',
          job_id,
          error: 'Job not found'
        });
      }
    }
  } catch (error) {
    console.error('Result API error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 WebsiteScraper v2 API running on port ${port}`);
  console.log(`☁️ Google Cloud Run deployment ready`);
  console.log(`🔗 Health check: http://localhost:${port}/`);
});