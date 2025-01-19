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

- **Node.js**: Ensure you have Node.js installed (version 14 or higher recommended).
- **Stable Diffusion API**: This project interfaces with a Stable Diffusion API instance. Make sure it's running and accessible.

## Installation

1. **Clone the Repository**

   ```bash
   git clone https://github.com/yourusername/image-rendering-api.git
   cd image-rendering-api

## Usage

node index.js

The server will run on http://0.0.0.0:8080/ by default.

## API Endpoint example:

`GET http://localhost:8080/?animal=dog&color=blue&personality=loyal`

## Learn More
- [Sogni website](https://sogni.ai/)
- [Sogni SDK docs](https://www.sogni.ai/sdk)

---

## License

This project is licensed under the terms of the [MIT License](LICENSE).
