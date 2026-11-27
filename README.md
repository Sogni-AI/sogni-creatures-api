# Sogni Creatures API

A customizable image rendering service (REST-based API) built on Sogni Supernet SDK. Uses Hapi.js, leveraging guide images and advanced image processing techniques to generate unique illustrations based on user-defined parameters.

See an example of it in action at: https://creatures.sogni.ai
Frontend code available at https://github.com/Sogni-AI/sogni-creatures-frontend

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)

## Features

- **Dynamic Image Generation**: Create images based on animal, color, and personality parameters.
- **Guide Image Integration**: Utilize blurred guide images to influence the rendering process.
- **Caching Mechanism**: Efficiently cache processed images to reduce redundant processing.
- **Configurable Rendering Settings**: Adjust model parameters such as steps, guidance scale, resolution, and more.
- **Robust Error Handling**: Comprehensive validation and error responses for smooth API interactions.

## Prerequisites

- **Node.js**: 18 or higher.
- **A Sogni account**: This project uses the [Sogni Supernet SDK](https://docs.sogni.ai/sdk) and needs valid credentials (see `.env.example`).

## Installation

1. **Clone the Repository**

   ```bash
   git clone https://github.com/Sogni-AI/sogni-creatures-api.git
   cd sogni-creatures-api
   ```
2. **Install dependencies**

   ```bash
   npm install
   ```
3. **Copy and fill in the env file**

   ```bash
   cp .env.example .env
   # then edit .env with your Sogni credentials
   ```

## Configuration

Set Sogni credentials and optional operational settings in `.env`:

| Variable | Default | Description |
| --- | --- | --- |
| `APP_ID` | *(required)* | Client application identifier passed to `@sogni-ai/sogni-client`. |
| `SOGNI_USERNAME` | *(required)* | Sogni account username. |
| `SOGNI_PASSWORD` | *(required)* | Sogni account password. |
| `HOST` | `0.0.0.0` | Bind address for the HTTP server. |
| `PORT` | `8084` | Listening port for the HTTP server. |
| `CORS_ORIGINS` | `*` | Allowed CORS origins (`*` or a comma-separated list of origins). |
| `API_KEY` | *(unset)* | Optional shared key for `GET /` (`Authorization: Bearer <key>` or `x-api-key: <key>`). Leave unset for unauthenticated browser access. |
| `TRUST_PROXY` | `false` | Set to `true` behind Cloudflare or a reverse proxy to read client IPs from `cf-connecting-ip` or `x-forwarded-for`. |
| `RATE_LIMIT_MAX` | `10` | Maximum `GET /` requests per client IP within each rate-limit window (`0` disables the built-in limiter). |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Per-IP rate-limit window duration in milliseconds. |
| `MAX_CONCURRENT_RENDERS` | `5` | Maximum concurrent active renders before returning `429`. |
| `RENDER_TIMEOUT_MS` | `60000` | Maximum wait time in milliseconds for a Sogni render job before cancelling and returning `504`. |
| `DOWNLOAD_TIMEOUT_MS` | `20000` | Maximum time in milliseconds to download a completed render result. |
| `MAX_IMAGE_BYTES` | `20971520` | Maximum rendered image download size in bytes (20 MiB). |

## Usage

```bash
npm start
```

The server listens on `http://0.0.0.0:8084/` by default.

Run the offline test suite with:

```bash
npm test
```

## API Endpoint example

`GET http://localhost:8084/?animal=dog&color=blue&personality=loyal`

## Production notes

By default, `API_KEY` is unset and `CORS_ORIGINS` is `*` so browser frontends such as `creatures.sogni.ai` work out of the box. Built-in per-IP rate limiting, active render concurrency caps, and render/download timeouts are enabled by default and can be tuned via environment variables alongside edge controls such as Cloudflare allowlists and rate-limiting rules.

## Learn More
- [Sogni website](https://sogni.ai/)
- [Sogni SDK docs](https://www.sogni.ai/sdk)

---

## License

This project is licensed under the terms of the [MIT License](LICENSE).
