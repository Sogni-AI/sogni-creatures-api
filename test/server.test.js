const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  createServer,
  downloadRenderedImage,
  isPublicIpAddress,
} = require('../index');

const dogFixtureBuffer = fs.readFileSync(path.join(__dirname, '..', 'animals', 'dog.png'));

function createMockProject({ autoCompleteUrls = null, cancelCallback = null } = {}) {
  const emitter = new EventEmitter();
  emitter.cancel = () => {
    if (cancelCallback) {
      cancelCallback();
    }
    return Promise.resolve();
  };
  if (autoCompleteUrls !== null) {
    process.nextTick(() => {
      emitter.emit('completed', autoCompleteUrls);
    });
  }
  return emitter;
}

describe('sogni-creatures-api server', () => {
  let mediaServer;
  let mediaBaseUrl;
  let lastOversizedStreamBytesSent = 0;

  before(async () => {
    mediaServer = http.createServer((req, res) => {
      if (req.url === '/fixture/dog.png') {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': String(dogFixtureBuffer.length),
        });
        res.end(dogFixtureBuffer);
        return;
      }

      if (req.url === '/fixture/oversized-header.png') {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': String(100 * 1024 * 1024),
        });
        res.write(Buffer.alloc(64 * 1024, 0xaa));
        return;
      }

      if (req.url === '/fixture/oversized-stream.png') {
        lastOversizedStreamBytesSent = 0;
        const totalTargetBytes = 100 * 1024 * 1024; // 100 MiB stream without Content-Length
        const chunk = Buffer.alloc(64 * 1024, 0x55);
        res.writeHead(200, { 'Content-Type': 'image/png' });

        let closed = false;
        const cleanup = () => {
          closed = true;
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);

        const pump = () => {
          while (!closed && lastOversizedStreamBytesSent < totalTargetBytes) {
            const ok = res.write(chunk);
            lastOversizedStreamBytesSent += chunk.length;
            if (!ok) {
              res.once('drain', pump);
              return;
            }
          }
          if (!closed) {
            res.end();
          }
        };

        pump();
        return;
      }

      if (req.url === '/fixture/redirect-local') {
        res.writeHead(302, {
          Location: `${mediaBaseUrl}/fixture/dog.png`,
        });
        res.end();
        return;
      }

      if (req.url === '/fixture/stalled-download.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.write(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise((resolve) => {
      mediaServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = mediaServer.address();
    mediaBaseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (mediaServer) {
      await new Promise((resolve) => mediaServer.close(resolve));
    }
  });

  it('renders a PNG image on valid parameters and rejects disallowed parameters with 400', async () => {
    const capturedParams = [];
    const sogniClient = {
      projects: {
        create: async (params) => {
          capturedParams.push(params);
          return createMockProject({ autoCompleteUrls: [`${mediaBaseUrl}/fixture/dog.png`] });
        },
      },
    };

    const server = await createServer({
      sogniClient,
      port: 0,
      host: '127.0.0.1',
      allowLocalMediaUrls: true,
      blurLevel: 1,
    });

    try {
      const okResponse = await server.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
        remoteAddress: '198.51.100.10',
      });

      assert.equal(okResponse.statusCode, 200);
      assert.equal(okResponse.headers['content-type'], 'image/png');
      assert.equal(
        okResponse.headers['content-disposition'],
        'inline; filename="rendered_image.png"'
      );
      // PNG file signature: 89 50 4E 47 0D 0A 1A 0A
      assert.deepEqual(
        okResponse.rawPayload.subarray(0, 8),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
      assert.equal(capturedParams.length, 1);
      assert.equal(capturedParams[0].type, 'image');
      assert.equal(capturedParams[0].negativePrompt, '');
      assert.ok(Buffer.isBuffer(capturedParams[0].startingImage));

      const invalidResponse = await server.inject({
        method: 'GET',
        url: '/?animal=unicorn&color=ultraviolet&personality=sleepy',
        remoteAddress: '198.51.100.10',
      });

      assert.equal(invalidResponse.statusCode, 400);
      const invalidPayload = JSON.parse(invalidResponse.payload);
      assert.equal(invalidPayload.errors.length, 3);
      assert.equal(capturedParams.length, 1);
    } finally {
      await server.stop();
    }
  });

  it('enforces per-IP rate limits with 429, Retry-After, and X-RateLimit headers before creating renders', async () => {
    let createdCount = 0;
    const sogniClient = {
      projects: {
        create: async () => {
          createdCount += 1;
          return createMockProject({ autoCompleteUrls: [`${mediaBaseUrl}/fixture/dog.png`] });
        },
      },
    };

    const rateLimitMax = 4;
    const server = await createServer({
      sogniClient,
      port: 0,
      host: '127.0.0.1',
      rateLimitMax,
      rateLimitWindowMs: 60_000,
      maxConcurrentRenders: 20,
      allowLocalMediaUrls: true,
      removeBackground: false,
    });

    try {
      const requests = Array.from({ length: 20 }, (_, index) =>
        server.inject({
          method: 'GET',
          url: '/?animal=dog&color=blue&personality=loyal',
          remoteAddress: '203.0.113.25',
          headers: {
            // Untrusted forwarded header is ignored when trustProxy is false
            'x-forwarded-for': `198.51.100.${index + 1}`,
          },
        })
      );

      const responses = await Promise.all(requests);
      const okResponses = responses.filter((res) => res.statusCode === 200);
      const limitedResponses = responses.filter((res) => res.statusCode === 429);

      assert.equal(okResponses.length, rateLimitMax);
      assert.equal(limitedResponses.length, 20 - rateLimitMax);
      assert.equal(createdCount, rateLimitMax);

      for (const limited of limitedResponses) {
        assert.equal(limited.headers['x-ratelimit-limit'], String(rateLimitMax));
        assert.equal(limited.headers['x-ratelimit-remaining'], '0');
        assert.ok(Number(limited.headers['x-ratelimit-reset']) > 0);
        assert.ok(Number(limited.headers['retry-after']) >= 1);
        const body = JSON.parse(limited.payload);
        assert.equal(body.error, 'Too many requests. Please try again shortly.');
      }
    } finally {
      await server.stop();
    }
  });

  it('caps active concurrent renders with 429 and releases slots when in-flight renders finish', async () => {
    const pendingProjects = [];
    const sogniClient = {
      projects: {
        create: async () => {
          const project = createMockProject();
          pendingProjects.push(project);
          return project;
        },
      },
    };

    const server = await createServer({
      sogniClient,
      port: 0,
      host: '127.0.0.1',
      rateLimitMax: 50,
      maxConcurrentRenders: 2,
      allowLocalMediaUrls: true,
      removeBackground: false,
    });

    try {
      const firstPromise = server.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
        remoteAddress: '203.0.113.40',
      });
      const secondPromise = server.inject({
        method: 'GET',
        url: '/?animal=cat&color=red&personality=wise',
        remoteAddress: '203.0.113.41',
      });

      while (pendingProjects.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const busyResponse = await server.inject({
        method: 'GET',
        url: '/?animal=fox&color=orange&personality=curious',
        remoteAddress: '203.0.113.42',
      });

      assert.equal(busyResponse.statusCode, 429);
      assert.equal(busyResponse.headers['retry-after'], '5');
      assert.equal(pendingProjects.length, 2);

      for (const project of pendingProjects) {
        project.emit('completed', [`${mediaBaseUrl}/fixture/dog.png`]);
      }

      const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
      assert.equal(firstRes.statusCode, 200);
      assert.equal(secondRes.statusCode, 200);

      // Next request succeeds once active slots have been released
      const nextPromise = server.inject({
        method: 'GET',
        url: '/?animal=owl&color=brown&personality=wise',
        remoteAddress: '203.0.113.43',
      });
      while (pendingProjects.length < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      pendingProjects[2].emit('completed', [`${mediaBaseUrl}/fixture/dog.png`]);
      const nextRes = await nextPromise;
      assert.equal(nextRes.statusCode, 200);
    } finally {
      await server.stop();
    }
  });

  it('enforces optional API_KEY on GET / while keeping GET /heartbeat open', async () => {
    let createdCount = 0;
    const sogniClient = {
      projects: {
        create: async () => {
          createdCount += 1;
          return createMockProject({ autoCompleteUrls: [`${mediaBaseUrl}/fixture/dog.png`] });
        },
      },
    };

    const configuredKey = 'test-shared-api-token-12345';
    const server = await createServer({
      sogniClient,
      port: 0,
      host: '127.0.0.1',
      apiKey: configuredKey,
      allowLocalMediaUrls: true,
      removeBackground: false,
    });

    try {
      const heartbeatRes = await server.inject({
        method: 'GET',
        url: '/heartbeat',
      });
      assert.equal(heartbeatRes.statusCode, 200);
      assert.equal(heartbeatRes.payload, '1');

      const missingAuthRes = await server.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
      });
      assert.equal(missingAuthRes.statusCode, 401);
      assert.deepEqual(JSON.parse(missingAuthRes.payload), { error: 'Unauthorized' });

      const wrongAuthRes = await server.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
        headers: {
          authorization: 'Bearer wrong-token',
        },
      });
      assert.equal(wrongAuthRes.statusCode, 401);
      assert.equal(createdCount, 0);

      const bearerRes = await server.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
        headers: {
          authorization: `Bearer ${configuredKey}`,
        },
      });
      assert.equal(bearerRes.statusCode, 200);

      const headerKeyRes = await server.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
        headers: {
          'x-api-key': configuredKey,
        },
      });
      assert.equal(headerKeyRes.statusCode, 200);
      assert.equal(createdCount, 2);
    } finally {
      await server.stop();
    }
  });

  it('times out stalled renders with 504, cancels the project, and detaches listeners', async () => {
    let cancelCalls = 0;
    let stalledProject;
    const sogniClient = {
      projects: {
        create: async () => {
          stalledProject = createMockProject({
            cancelCallback: () => {
              cancelCalls += 1;
            },
          });
          return stalledProject;
        },
      },
    };

    const server = await createServer({
      sogniClient,
      port: 0,
      host: '127.0.0.1',
      renderTimeoutMs: 80,
      allowLocalMediaUrls: true,
    });

    try {
      const startedAt = Date.now();
      const response = await server.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
      });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(response.statusCode, 504);
      assert.deepEqual(JSON.parse(response.payload), { error: 'Image rendering timed out.' });
      assert.ok(elapsedMs < 2000, `Expected prompt timeout, took ${elapsedMs}ms`);
      assert.equal(cancelCalls, 1);
      assert.equal(stalledProject.listenerCount('completed'), 0);
      assert.equal(stalledProject.listenerCount('failed'), 0);
    } finally {
      await server.stop();
    }
  });

  it('returns 504 when downloading a rendered image times out', async () => {
    const sogniClient = {
      projects: {
        create: async () =>
          createMockProject({ autoCompleteUrls: [`${mediaBaseUrl}/fixture/stalled-download.png`] }),
      },
    };

    const server = await createServer({
      sogniClient,
      port: 0,
      host: '127.0.0.1',
      downloadTimeoutMs: 80,
      allowLocalMediaUrls: true,
    });

    try {
      const startedAt = Date.now();
      const response = await server.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
      });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(response.statusCode, 504);
      assert.deepEqual(JSON.parse(response.payload), { error: 'Image download timed out.' });
      assert.ok(elapsedMs < 2000, `Expected prompt download timeout, took ${elapsedMs}ms`);
    } finally {
      await server.stop();
    }
  });

  it('aborts oversized image downloads mid-stream before full payload transfer and validates media URLs', async () => {
    const maxImageBytes = 512 * 1024; // 512 KiB cap against a 100 MiB response stream

    await assert.rejects(
      () =>
        downloadRenderedImage(`${mediaBaseUrl}/fixture/oversized-header.png`, {
          maxImageBytes,
          downloadTimeoutMs: 5_000,
          allowLocalMediaUrls: true,
        }),
      (err) => err && err.code === 'IMAGE_TOO_LARGE'
    );

    await assert.rejects(
      () =>
        downloadRenderedImage(`${mediaBaseUrl}/fixture/oversized-stream.png`, {
          maxImageBytes,
          downloadTimeoutMs: 5_000,
          allowLocalMediaUrls: true,
        }),
      (err) => err && err.code === 'IMAGE_TOO_LARGE'
    );

    assert.ok(
      lastOversizedStreamBytesSent < 10 * 1024 * 1024,
      `Expected stream abort well before 100 MiB, server wrote ${lastOversizedStreamBytesSent} bytes`
    );

    // Non-HTTPS and non-public addresses are rejected when allowLocalMediaUrls is false
    await assert.rejects(
      () =>
        downloadRenderedImage(`${mediaBaseUrl}/fixture/dog.png`, {
          allowLocalMediaUrls: false,
        }),
      (err) => err && err.code === 'INVALID_MEDIA_URL'
    );

    await assert.rejects(
      () =>
        downloadRenderedImage('https://127.0.0.1/image.png', {
          allowLocalMediaUrls: false,
        }),
      (err) => err && err.code === 'INVALID_MEDIA_URL'
    );

    await assert.rejects(
      () =>
        downloadRenderedImage('https://[::127.0.0.1]/image.png', {
          allowLocalMediaUrls: false,
        }),
      (err) => err && err.code === 'INVALID_MEDIA_URL'
    );

    await assert.rejects(
      () =>
        downloadRenderedImage('https://user:pass@example.com/image.png', {
          allowLocalMediaUrls: false,
        }),
      (err) => err && err.code === 'INVALID_MEDIA_URL'
    );

    assert.equal(isPublicIpAddress('127.0.0.1'), false);
    assert.equal(isPublicIpAddress('169.254.169.254'), false);
    assert.equal(isPublicIpAddress('10.0.0.8'), false);
    assert.equal(isPublicIpAddress('::1'), false);
    assert.equal(isPublicIpAddress('::7f00:1'), false);
    assert.equal(isPublicIpAddress('::a9fe:a9fe'), false);
    assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false);
    assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
    assert.equal(isPublicIpAddress('93.184.216.34'), true);

    // Redirect hops are re-validated too
    const redirectedBuffer = await downloadRenderedImage(`${mediaBaseUrl}/fixture/redirect-local`, {
      allowLocalMediaUrls: true,
    });
    assert.equal(redirectedBuffer.length, dogFixtureBuffer.length);
  });

  it('supports TRUST_PROXY client IP headers and RATE_LIMIT_MAX=0 opt-out', async () => {
    const sogniClient = {
      projects: {
        create: async () => createMockProject({ autoCompleteUrls: [`${mediaBaseUrl}/fixture/dog.png`] }),
      },
    };

    const proxyServer = await createServer({
      sogniClient,
      port: 0,
      host: '127.0.0.1',
      trustProxy: true,
      rateLimitMax: 1,
      allowLocalMediaUrls: true,
      removeBackground: false,
    });

    try {
      const firstClientA = await proxyServer.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
        remoteAddress: '10.0.0.2',
        headers: { 'cf-connecting-ip': '198.51.100.77' },
      });
      const secondClientA = await proxyServer.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
        remoteAddress: '10.0.0.2',
        headers: { 'cf-connecting-ip': '198.51.100.77' },
      });
      const firstClientB = await proxyServer.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
        remoteAddress: '10.0.0.2',
        headers: { 'cf-connecting-ip': '198.51.100.88' },
      });

      assert.equal(firstClientA.statusCode, 200);
      assert.equal(secondClientA.statusCode, 429);
      assert.equal(firstClientB.statusCode, 200);
    } finally {
      await proxyServer.stop();
    }

    const unlimitedServer = await createServer({
      sogniClient,
      port: 0,
      host: '127.0.0.1',
      rateLimitMax: 0,
      allowLocalMediaUrls: true,
      removeBackground: false,
    });

    try {
      const res = await unlimitedServer.inject({
        method: 'GET',
        url: '/?animal=dog&color=blue&personality=loyal',
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-ratelimit-limit'], undefined);
    } finally {
      await unlimitedServer.stop();
    }
  });
});
