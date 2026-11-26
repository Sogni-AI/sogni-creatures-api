require('dotenv').config();
const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const Hapi = require('@hapi/hapi');
const Inert = require('@hapi/inert');
const axios = require('axios');
const sharp = require('sharp');
const NodeCache = require('node-cache');
const removeImageBackground = require('./lib/removeImageBackground');
const { SogniClient } = require('@sogni-ai/sogni-client');

// Render configuration
const defaultBlurLevel = 0; // Adjust as needed, set to 0 to disable
const overrideModel = 'coreml-animagineXLV31'; // Model to use
const steps = 32;
const guidance = 8;
const startingImageStrength = 0.20;
// Sampler/scheduler naming changed in sogni-client 4.0.0. The old `scheduler`
// became `sampler` (string alias) and the old `timeStepSpacing` became
// `scheduler`. Use `sogni.projects.getModelOptions(modelId)` at runtime to
// discover valid options for a given model.
const sampler = 'dpmpp_2m_sde';
const scheduler = 'karras';
const defaultRemoveBackground = true; // Set to false to disable background removal

// Operational defaults
const DEFAULT_PORT = 8084;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_RATE_LIMIT_MAX = 10;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_TRACKED_IPS = 10_000;
const DEFAULT_MAX_CONCURRENT_RENDERS = 5;
const DEFAULT_RENDER_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 3;

const animals = [
  'ant', 'bear', 'bee', 'butterfly', 'caterpillar', 'cat', 'crab', 'crocodile',
  'deer', 'dog', 'dolphin', 'dragon', 'dragonfly', 'eagle', 'elephant', 'fish',
  'fox', 'giraffe', 'gorilla', 'horse', 'jellyfish', 'kangaroo', 'koala',
  'ladybug', 'lion', 'lobster', 'mantis', 'monkey', 'octopus', 'owl', 'panda',
  'penguin', 'rabbit', 'scorpion', 'seal', 'seahorse', 'shark', 'shrimp',
  'squid', 'squirrel', 'starfish', 'spider', 'tiger', 'turtle', 'whale', 'zebra',
];
const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'black', 'white', 'grey', 'brown'];
const personalities = [
  'loyal', 'courageous', 'free-spirited', 'majestic', 'wise', 'energetic', 'curious',
  'icy', 'fiery', 'psychic', 'degen', 'fairy', 'fighting', 'techno',
];

const animalsDir = path.join(__dirname, 'animals');

const NON_PUBLIC_BLOCKLIST = (() => {
  const blockList = new net.BlockList();
  // Non-public IPv4 ranges
  blockList.addSubnet('0.0.0.0', 8, 'ipv4');
  blockList.addSubnet('10.0.0.0', 8, 'ipv4');
  blockList.addSubnet('100.64.0.0', 10, 'ipv4');
  blockList.addSubnet('127.0.0.0', 8, 'ipv4');
  blockList.addSubnet('169.254.0.0', 16, 'ipv4');
  blockList.addSubnet('172.16.0.0', 12, 'ipv4');
  blockList.addSubnet('192.0.0.0', 24, 'ipv4');
  blockList.addSubnet('192.0.2.0', 24, 'ipv4');
  blockList.addSubnet('192.168.0.0', 16, 'ipv4');
  blockList.addSubnet('198.18.0.0', 15, 'ipv4');
  blockList.addSubnet('198.51.100.0', 24, 'ipv4');
  blockList.addSubnet('203.0.113.0', 24, 'ipv4');
  blockList.addSubnet('224.0.0.0', 4, 'ipv4');
  blockList.addSubnet('240.0.0.0', 4, 'ipv4');
  // Non-public IPv6 ranges
  blockList.addSubnet('::', 128, 'ipv6');
  blockList.addSubnet('::1', 128, 'ipv6');
  blockList.addSubnet('64:ff9b::', 96, 'ipv6');
  blockList.addSubnet('64:ff9b:1::', 48, 'ipv6');
  blockList.addSubnet('100::', 64, 'ipv6');
  blockList.addSubnet('2001::', 32, 'ipv6');
  blockList.addSubnet('2001:db8::', 32, 'ipv6');
  blockList.addSubnet('2002::', 16, 'ipv6');
  blockList.addSubnet('fc00::', 7, 'ipv6');
  blockList.addSubnet('fe80::', 10, 'ipv6');
  blockList.addSubnet('ff00::', 8, 'ipv6');
  return blockList;
})();

function createCodedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function parseConfigInt(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseCorsOrigins(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value : ['*'];
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return ['*'];
  }
  const origins = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : ['*'];
}

function isPublicIpAddress(rawAddress) {
  if (typeof rawAddress !== 'string' || rawAddress.trim() === '') {
    return false;
  }
  const cleanAddress = rawAddress.split('%')[0].trim();
  const family = net.isIP(cleanAddress);
  if (family !== 4 && family !== 6) {
    return false;
  }
  return !NON_PUBLIC_BLOCKLIST.check(cleanAddress, family === 4 ? 'ipv4' : 'ipv6');
}

function extractProvidedApiKey(headers = {}) {
  const headerApiKey = headers['x-api-key'];
  if (typeof headerApiKey === 'string' && headerApiKey.length > 0) {
    return headerApiKey;
  }
  const authHeader = headers.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return '';
}

function isValidApiKey(providedKey, expectedKey) {
  if (typeof providedKey !== 'string' || providedKey.length === 0) {
    return false;
  }
  const providedDigest = crypto.createHash('sha256').update(providedKey, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedKey, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function getClientIp(request, trustProxy) {
  if (trustProxy) {
    const cfIp = request.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim() !== '') {
      return cfIp.split(',')[0].trim();
    }
    const forwardedFor = request.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim() !== '') {
      return forwardedFor.split(',')[0].trim();
    }
  }
  return request.info?.remoteAddress || 'unknown';
}

function createRateLimiter({ maxRequests, windowMs, maxTrackedIps = DEFAULT_MAX_TRACKED_IPS }) {
  const buckets = new Map();
  let lastSweepAt = Date.now();

  const sweepExpired = (now) => {
    for (const [ip, entry] of buckets) {
      if (now >= entry.resetAt) {
        buckets.delete(ip);
      }
    }
    lastSweepAt = now;
  };

  return {
    consume(clientIp, now = Date.now()) {
      if (maxRequests <= 0) {
        return { allowed: true, headers: null };
      }

      if (now - lastSweepAt >= windowMs) {
        sweepExpired(now);
      }

      let entry = buckets.get(clientIp);
      if (!entry || now >= entry.resetAt) {
        if (!entry && buckets.size >= maxTrackedIps) {
          sweepExpired(now);
          if (buckets.size >= maxTrackedIps) {
            const oldestKey = buckets.keys().next().value;
            if (oldestKey !== undefined) {
              buckets.delete(oldestKey);
            }
          }
        }
        entry = {
          count: 0,
          resetAt: now + windowMs,
        };
        buckets.set(clientIp, entry);
      }

      const resetEpochSeconds = Math.ceil(entry.resetAt / 1000);
      if (entry.count >= maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        return {
          allowed: false,
          retryAfterSeconds,
          headers: {
            'X-RateLimit-Limit': String(maxRequests),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(resetEpochSeconds),
          },
        };
      }

      entry.count += 1;
      const remaining = Math.max(0, maxRequests - entry.count);
      return {
        allowed: true,
        headers: {
          'X-RateLimit-Limit': String(maxRequests),
          'X-RateLimit-Remaining': String(remaining),
          'X-RateLimit-Reset': String(resetEpochSeconds),
        },
      };
    },
    size() {
      return buckets.size;
    },
  };
}

function applyHeaders(response, headers) {
  if (!headers) {
    return response;
  }
  for (const [name, value] of Object.entries(headers)) {
    response.header(name, value);
  }
  return response;
}

/**
 * Await project completion with a bounded timeout and listener cleanup.
 * @param {object} project - Sogni project instance
 * @param {number} [timeoutMs] - Maximum wait time in milliseconds
 * @returns {Promise<Array<string>>} - Resolved image URL list
 */
function waitProjectCompletion(
  project,
  timeoutMs = parseConfigInt(process.env.RENDER_TIMEOUT_MS, DEFAULT_RENDER_TIMEOUT_MS)
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const detach = (event, listener) => {
      if (typeof project.off === 'function') {
        project.off(event, listener);
      } else if (typeof project.removeListener === 'function') {
        project.removeListener(event, listener);
      }
    };

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      detach('completed', onCompleted);
      detach('failed', onFailed);
    };

    const onCompleted = (data) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(data);
    };

    const onFailed = (data) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(data instanceof Error ? data : new Error(String(data || 'Image render failed.')));
    };

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (typeof project.cancel === 'function') {
        Promise.resolve(project.cancel()).catch(() => {});
      }
      reject(createCodedError('Image rendering timed out.', 'RENDER_TIMEOUT'));
    }, timeoutMs);

    project.on('completed', onCompleted);
    project.on('failed', onFailed);
  });
}

async function resolveMediaTarget(rawUrl, { allowLocalMediaUrls = false, lookupFn = dns.promises.lookup } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw createCodedError('Invalid rendered image URL.', 'INVALID_MEDIA_URL');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createCodedError('Invalid rendered image URL.', 'INVALID_MEDIA_URL');
  }

  if (parsed.username || parsed.password) {
    throw createCodedError('Credentials are not supported in rendered image URLs.', 'INVALID_MEDIA_URL');
  }

  const allowedProtocols = allowLocalMediaUrls ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw createCodedError(`Unsupported rendered image protocol: ${parsed.protocol}`, 'INVALID_MEDIA_URL');
  }

  const hostname =
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  if (!hostname) {
    throw createCodedError('Missing hostname in rendered image URL.', 'INVALID_MEDIA_URL');
  }

  const literalFamily = net.isIP(hostname.split('%')[0]);
  let records;
  if (literalFamily === 4 || literalFamily === 6) {
    records = [{ address: hostname, family: literalFamily }];
  } else {
    records = await lookupFn(hostname, { all: true, verbatim: true });
    if (!Array.isArray(records) || records.length === 0) {
      throw createCodedError('Unable to resolve rendered image host.', 'INVALID_MEDIA_URL');
    }
  }

  if (!allowLocalMediaUrls) {
    for (const record of records) {
      if (!isPublicIpAddress(record.address)) {
        throw createCodedError('Rendered image host resolved to a non-public address.', 'INVALID_MEDIA_URL');
      }
    }
  }

  const pinnedLookup = (_host, lookupOptions, callback) => {
    const cb = typeof lookupOptions === 'function' ? lookupOptions : callback;
    const opts = typeof lookupOptions === 'object' && lookupOptions !== null ? lookupOptions : {};
    if (opts.all) {
      cb(
        null,
        records.map(({ address, family }) => ({ address, family }))
      );
      return;
    }
    cb(null, records[0].address, records[0].family);
  };

  return { parsed, pinnedLookup };
}

/**
 * Download a rendered image with URL validation, redirect re-validation, timeout, and size cap.
 * @param {string} imageUrl - Rendered image URL
 * @param {object} [options] - Download options
 * @returns {Promise<Buffer>} - Downloaded image bytes
 */
async function downloadRenderedImage(imageUrl, options = {}) {
  const downloadTimeoutMs = parseConfigInt(
    options.downloadTimeoutMs ?? process.env.DOWNLOAD_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_TIMEOUT_MS
  );
  const maxImageBytes = parseConfigInt(
    options.maxImageBytes ?? process.env.MAX_IMAGE_BYTES,
    DEFAULT_MAX_IMAGE_BYTES
  );
  const allowLocalMediaUrls =
    options.allowLocalMediaUrls !== undefined
      ? Boolean(options.allowLocalMediaUrls)
      : process.env.ALLOW_LOCAL_MEDIA_URLS === 'true';
  const lookupFn = options.lookupFn || dns.promises.lookup;

  const deadline = Date.now() + downloadTimeoutMs;
  let currentUrl = imageUrl;

  for (let redirectCount = 0; redirectCount <= MAX_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw createCodedError('Image download timed out.', 'DOWNLOAD_TIMEOUT');
    }

    const { parsed, pinnedLookup } = await resolveMediaTarget(currentUrl, {
      allowLocalMediaUrls,
      lookupFn,
    });

    const agent =
      parsed.protocol === 'https:'
        ? new https.Agent({ keepAlive: false, lookup: pinnedLookup })
        : new http.Agent({ keepAlive: false, lookup: pinnedLookup });

    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);

    let response;
    try {
      response = await axios.get(parsed.toString(), {
        responseType: 'stream',
        maxRedirects: 0,
        timeout: remainingMs,
        signal: controller.signal,
        httpAgent: parsed.protocol === 'http:' ? agent : undefined,
        httpsAgent: parsed.protocol === 'https:' ? agent : undefined,
        decompress: true,
        validateStatus: () => true,
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      agent.destroy();
      if (timedOut || err.code === 'ECONNABORTED') {
        throw createCodedError('Image download timed out.', 'DOWNLOAD_TIMEOUT');
      }
      throw err;
    }

    const stream = response.data;

    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      clearTimeout(timeoutHandle);
      stream.destroy();
      agent.destroy();
      if (redirectCount === MAX_DOWNLOAD_REDIRECTS) {
        throw createCodedError('Too many redirects while downloading image.', 'INVALID_MEDIA_URL');
      }
      currentUrl = new URL(response.headers.location, parsed).toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      clearTimeout(timeoutHandle);
      stream.destroy();
      agent.destroy();
      throw createCodedError(
        `Unexpected status ${response.status} while downloading image.`,
        'DOWNLOAD_FAILED'
      );
    }

    const declaredLength = Number(response.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxImageBytes) {
      clearTimeout(timeoutHandle);
      controller.abort();
      stream.destroy();
      if (stream.req && typeof stream.req.destroy === 'function') {
        stream.req.destroy();
      }
      agent.destroy();
      throw createCodedError('Rendered image exceeds maximum allowed size.', 'IMAGE_TOO_LARGE');
    }

    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalBytes = 0;
      let finished = false;

      const finalize = (err, buffer) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeoutHandle);
        agent.destroy();
        if (err) {
          reject(err);
        } else {
          resolve(buffer);
        }
      };

      stream.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxImageBytes) {
          chunks.length = 0;
          const oversizeErr = createCodedError(
            'Rendered image exceeds maximum allowed size.',
            'IMAGE_TOO_LARGE'
          );
          finalize(oversizeErr);
          controller.abort();
          stream.destroy();
          if (stream.req && typeof stream.req.destroy === 'function') {
            stream.req.destroy();
          }
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        finalize(null, Buffer.concat(chunks, totalBytes));
      });

      stream.on('error', (err) => {
        if (timedOut) {
          finalize(createCodedError('Image download timed out.', 'DOWNLOAD_TIMEOUT'));
          return;
        }
        finalize(err);
      });

      stream.on('aborted', () => {
        if (timedOut) {
          finalize(createCodedError('Image download timed out.', 'DOWNLOAD_TIMEOUT'));
          return;
        }
        finalize(createCodedError('Rendered image stream ended unexpectedly.', 'DOWNLOAD_FAILED'));
      });
    });
  }

  throw createCodedError('Too many redirects while downloading image.', 'INVALID_MEDIA_URL');
}

async function createServer(options = {}) {
  const sogni = options.sogniClient;
  if (!sogni || !sogni.projects || typeof sogni.projects.create !== 'function') {
    throw new Error('A Sogni client instance with projects.create is required.');
  }

  const port =
    options.port !== undefined
      ? options.port
      : process.env.PORT !== undefined && process.env.PORT !== ''
        ? Number(process.env.PORT)
        : DEFAULT_PORT;
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
  const corsOrigins = parseCorsOrigins(options.corsOrigins ?? process.env.CORS_ORIGINS);
  const apiKey = options.apiKey !== undefined ? String(options.apiKey) : process.env.API_KEY || '';
  const rateLimitMax = parseConfigInt(
    options.rateLimitMax ?? process.env.RATE_LIMIT_MAX,
    DEFAULT_RATE_LIMIT_MAX,
    { allowZero: true }
  );
  const rateLimitWindowMs = parseConfigInt(
    options.rateLimitWindowMs ?? process.env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS
  );
  const maxTrackedIps = parseConfigInt(options.maxTrackedIps, DEFAULT_MAX_TRACKED_IPS);
  const trustProxy =
    options.trustProxy !== undefined
      ? Boolean(options.trustProxy)
      : process.env.TRUST_PROXY === 'true';
  const maxConcurrentRenders = parseConfigInt(
    options.maxConcurrentRenders ?? process.env.MAX_CONCURRENT_RENDERS,
    DEFAULT_MAX_CONCURRENT_RENDERS
  );
  const renderTimeoutMs = parseConfigInt(
    options.renderTimeoutMs ?? process.env.RENDER_TIMEOUT_MS,
    DEFAULT_RENDER_TIMEOUT_MS
  );
  const downloadTimeoutMs = parseConfigInt(
    options.downloadTimeoutMs ?? process.env.DOWNLOAD_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_TIMEOUT_MS
  );
  const maxImageBytes = parseConfigInt(
    options.maxImageBytes ?? process.env.MAX_IMAGE_BYTES,
    DEFAULT_MAX_IMAGE_BYTES
  );
  const serverTimeoutMs = parseConfigInt(
    options.serverTimeoutMs ?? process.env.SERVER_TIMEOUT_MS,
    renderTimeoutMs + downloadTimeoutMs + 5_000
  );
  const allowLocalMediaUrls =
    options.allowLocalMediaUrls !== undefined
      ? Boolean(options.allowLocalMediaUrls)
      : process.env.ALLOW_LOCAL_MEDIA_URLS === 'true';
  const blurLevel =
    options.blurLevel !== undefined ? Number(options.blurLevel) : defaultBlurLevel;
  const removeBackground =
    options.removeBackground !== undefined
      ? Boolean(options.removeBackground)
      : defaultRemoveBackground;

  const cache = new NodeCache({ stdTTL: 3600 });
  const rateLimiter = createRateLimiter({
    maxRequests: rateLimitMax,
    windowMs: rateLimitWindowMs,
    maxTrackedIps,
  });
  let activeRenders = 0;

  async function getGuideImage(inputPath) {
    const cacheKey = `raw_${path.basename(inputPath)}`;
    const cachedRaw = cache.get(cacheKey);
    if (cachedRaw) {
      return cachedRaw;
    }
    const rawBuffer = await fs.promises.readFile(inputPath);
    cache.set(cacheKey, rawBuffer);
    return rawBuffer;
  }

  async function blurImage(inputPath) {
    const cacheKey = `blurred_${path.basename(inputPath)}`;
    const cachedImage = cache.get(cacheKey);
    if (cachedImage) {
      console.log(`Using cached blurred image for: ${inputPath}`);
      return cachedImage;
    }

    const rawBuffer = await getGuideImage(inputPath);
    const blurredBuffer = await sharp(rawBuffer).blur(blurLevel).toBuffer();
    cache.set(cacheKey, blurredBuffer);
    console.log(`Image blurred and cached: ${inputPath}`);
    return blurredBuffer;
  }

  const server = Hapi.server({
    port,
    host,
    routes: {
      cors: {
        origin: corsOrigins,
      },
      timeout: {
        server: serverTimeoutMs,
        socket: serverTimeoutMs + 5_000,
      },
    },
  });

  await server.register(Inert);

  server.route({
    method: 'GET',
    path: '/heartbeat',
    handler: (_request, h) => {
      return h.response('1').code(200);
    },
  });

  server.route({
    method: 'GET',
    path: '/',
    handler: async (request, h) => {
      const startTime = Date.now();

      if (apiKey.length > 0) {
        const providedKey = extractProvidedApiKey(request.headers);
        if (!isValidApiKey(providedKey, apiKey)) {
          return h.response({ error: 'Unauthorized' }).code(401);
        }
      }

      const clientIp = getClientIp(request, trustProxy);
      const rateLimitResult = rateLimiter.consume(clientIp);
      if (!rateLimitResult.allowed) {
        const response = h
          .response({ error: 'Too many requests. Please try again shortly.' })
          .code(429)
          .header('Retry-After', String(rateLimitResult.retryAfterSeconds));
        return applyHeaders(response, rateLimitResult.headers);
      }

      const sendResult = (resultingImage) => {
        const endTime = Date.now();
        const totalRequestTime = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`Total request processing time: ${totalRequestTime} seconds`);
        const response = h
          .response(resultingImage)
          .type('image/png')
          .header('Content-Disposition', 'inline; filename="rendered_image.png"');
        return applyHeaders(response, rateLimitResult.headers);
      };

      const sendError = (message, statusCode = 500) => {
        const response = h.response({ error: message }).code(statusCode);
        return applyHeaders(response, rateLimitResult.headers);
      };

      const { animal, color, personality } = request.query;
      const errors = [];

      if (!animal || !animals.includes(animal)) {
        errors.push({
          parameter: 'animal',
          message: 'Invalid or missing animal parameter.',
          valid_values: animals,
        });
      }

      if (!color || !colors.includes(color)) {
        errors.push({
          parameter: 'color',
          message: 'Invalid or missing color parameter.',
          valid_values: colors,
        });
      }

      if (!personality || !personalities.includes(personality)) {
        errors.push({
          parameter: 'personality',
          message: 'Invalid or missing personality parameter.',
          valid_values: personalities,
        });
      }

      if (errors.length > 0) {
        return applyHeaders(h.response({ errors }).code(400), rateLimitResult.headers);
      }

      if (activeRenders >= maxConcurrentRenders) {
        const response = h
          .response({ error: 'Too many concurrent render requests. Please try again shortly.' })
          .code(429)
          .header('Retry-After', '5');
        return applyHeaders(response, rateLimitResult.headers);
      }

      activeRenders += 1;
      try {
        const prompt = `((one ${animal})), cute, full size, against a (solid fill background). ${color}-colored body, with an expression and stance conveying a ${personality} personality. Solid Blank background, collectable creature, very cute and kawaii illustration, whimsical chibi art, lofi anime art, kanto style, semi-realistic fantasy animal, pokemon-style`;
        const guideImagePath = path.join(animalsDir, `${animal}.png`);

        let startingImage;
        try {
          if (blurLevel > 0) {
            startingImage = await blurImage(guideImagePath);
          } else {
            startingImage = await getGuideImage(guideImagePath);
          }
        } catch (error) {
          console.error('Error retrieving guide image:', error);
          return sendError('Error processing guide image.');
        }

        // sogni-client 5.0 ImageProjectParams: requires `type: 'image'`,
        // uses `numberOfMedia` (formerly `numberOfImages`), and uses
        // `sampler`/`scheduler` string aliases (formerly `scheduler`/`timeStepSpacing`).
        const project = await sogni.projects.create({
          type: 'image',
          modelId: overrideModel,
          positivePrompt: prompt,
          negativePrompt: '',
          stylePrompt: '',
          steps,
          guidance,
          numberOfMedia: 1,
          startingImage,
          startingImageStrength,
          sampler,
          scheduler,
        });

        const urls = await waitProjectCompletion(project, renderTimeoutMs);
        if (!Array.isArray(urls) || !urls[0]) {
          throw createCodedError('No rendered image URL returned.', 'EMPTY_RENDER_RESULT');
        }

        const imageBuffer = await downloadRenderedImage(urls[0], {
          downloadTimeoutMs,
          maxImageBytes,
          allowLocalMediaUrls,
          lookupFn: options.lookupFn,
        });

        if (!removeBackground) {
          return sendResult(imageBuffer);
        }

        try {
          const resultingImage = await removeImageBackground(imageBuffer);
          return sendResult(resultingImage);
        } catch (err) {
          console.error('Error processing image:', err);
          return sendError('Error processing image.');
        }
      } catch (error) {
        if (error && error.code === 'RENDER_TIMEOUT') {
          console.error('Image rendering timed out:', error.message);
          return sendError('Image rendering timed out.', 504);
        }
        console.error('Error during image rendering:', error);
        return sendError('Error rendering image.', 500);
      } finally {
        activeRenders -= 1;
      }
    },
  });

  return server;
}

const init = async () => {
  const sogni = await SogniClient.createInstance({
    appId: process.env.APP_ID,
    testnet: true,
    network: 'fast',
    logLevel: 'warn', // Set to 'debug' to see what is sent/received through socket
  });

  sogni.apiClient.on('connected', () => {
    console.log('Connected to Sogni API');
  });

  sogni.apiClient.on('disconnected', ({ code, reason }) => {
    console.error('Disconnected from Sogni API', code, reason);
    setTimeout(() => {
      process.exit(1);
    }, 100);
  });

  await sogni.account.login(process.env.SOGNI_USERNAME, process.env.SOGNI_PASSWORD);

  const server = await createServer({ sogniClient: sogni });
  await server.start();
  console.log('Server running on %s', server.info.uri);
  return server;
};

if (require.main === module) {
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
    process.exit(1);
  });

  init();
}

module.exports = {
  createServer,
  waitProjectCompletion,
  downloadRenderedImage,
  isPublicIpAddress,
  init,
};
