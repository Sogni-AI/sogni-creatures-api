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

## Usage

```bash
npm start
```

The server listens on `http://0.0.0.0:8084/` by default.

## API Endpoint example

`GET http://localhost:8084/?animal=dog&color=blue&personality=loyal`

## Production notes

This service has **no built-in authentication and CORS is wide open by default**, so operators are expected to put it behind their own auth/rate-limit/CORS layer before exposing it to the public internet. The reference deployment (`creatures.sogni.ai`) runs behind a Cloudflare allowlist and a per-IP rate limit.

## Learn More
- [Sogni website](https://sogni.ai/)
- [Sogni SDK docs](https://www.sogni.ai/sdk)

---

## License

This project is licensed under the terms of the [MIT License](LICENSE).
