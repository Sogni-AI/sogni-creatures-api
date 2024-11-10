const Hapi = require('@hapi/hapi');
const Inert = require('@hapi/inert');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');
const NodeCache = require('node-cache');

// Configuration
const apiUrl = 'http://localhost:7860/';
const useInitImage = true; // Use guide images
const blurLevel = 40; // Adjust as needed
const overrideModel = 'flux1-schnell-fp8'; // Model to use
const steps = 35;
const cfgScale = 9; // Guidance
const resolution = { width: 1024, height: 1024 };
const denoisingStrength = 0.75;
const sampler = 'Euler a';
const scheduler = 'Karras';

const animals = ['bee', 'crocodile', 'dog', 'jellyfish', 'koala', 'panda', 'scorpion', 'tiger'];
const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'black', 'white', 'grey', 'brown'];
const personalities = ['loyal', 'courageous', 'free-spirited', 'majestic', 'wise', 'energetic', 'curious', 'icy', 'fiery', 'psychic', 'degen', 'fairy', 'fighting', 'techno'];

const animalsDir = path.join(__dirname, 'animals'); // Guide images directory

// Initialize cache
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour TTL

// Create an Axios instance with connection pooling
const axiosInstance = axios.create({
  baseURL: apiUrl,
  timeout: 30000, // 30 seconds timeout
  httpAgent: new require('http').Agent({ keepAlive: true }),
  httpsAgent: new require('https').Agent({ keepAlive: true }),
});

// Function to blur the image and cache it
async function blurImage(inputPath) {
  try {
    const cachedImage = cache.get(`blurred_${path.basename(inputPath)}`);
    if (cachedImage) {
      console.log(`Using cached blurred image for: ${inputPath}`);
      return cachedImage;
    }

    const blurredBuffer = await sharp(inputPath)
      .blur(blurLevel)
      .toBuffer();

    cache.set(`blurred_${path.basename(inputPath)}`, blurredBuffer);
    console.log(`Image blurred and cached: ${inputPath}`);
    return blurredBuffer;
  } catch (error) {
    console.error(`Error blurring image: ${inputPath}`, error);
    throw error;
  }
}

// Function to check the currently loaded model
async function getCurrentModel() {
  try {
    const response = await axiosInstance.get('sdapi/v1/options');
    return response.data.sd_model_checkpoint;
  } catch (error) {
    console.error('Error fetching current model:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Initialize model only if needed based on the API response
async function initializeModelIfNeeded(model) {
  try {
    const activeModel = await getCurrentModel();
    if (activeModel === model) {
      console.log(`Model ${model} is already loaded.`);
      return;
    }

    await axiosInstance.post('sdapi/v1/options', {
      sd_model_checkpoint: model,
    });
    console.log(`Initialized with model: ${model}`);
  } catch (error) {
    console.error(`Error initializing model to ${model}:`, error.response ? error.response.data : error.message);
    process.exit(1);
  }
}

// Function to render the image
async function renderWithGuideImage(prompt, blurredBuffer) {
  try {
    let initImages = [];
    if (useInitImage) {
      const blurredImageBase64 = blurredBuffer.toString('base64');
      initImages = [`data:image/jpeg;base64,${blurredImageBase64}`];
      console.log('Using guide image for rendering...');
    } else {
      console.log('Rendering without guide image...');
    }

    const requestData = {
      prompt: prompt,
      steps: 4,
      cfg_scale: 1,
      width: resolution.width,
      height: resolution.height,
      sampler_name: 'Euler',
      scheduler: 'Simple',
      ...(useInitImage
        ? {
            init_images: initImages,
            denoising_strength: denoisingStrength,
          }
        : {}),
    };

    console.log(`Sending rendering request for prompt: "${prompt}"`);

    const endpoint = useInitImage ? 'sdapi/v1/img2img' : 'sdapi/v1/txt2img';
    const response = await axiosInstance.post(endpoint, requestData);

    if (!response.data || !response.data.images || !response.data.images.length) {
      console.error('No images returned from rendering API:', response.data);
      throw new Error('No images returned from rendering API.');
    }

    const imageBase64 = response.data.images[0];
    const imageBuffer = Buffer.from(imageBase64, 'base64');

    console.log('Image rendered successfully.');

    return imageBuffer;
  } catch (error) {
    console.error('Error rendering image:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Initialize the Hapi server
const init = async () => {
  await initializeModelIfNeeded(overrideModel);

  const server = Hapi.server({
    port: 8080,
    host: '0.0.0.0',
    routes: {
      cors: {
        origin: ['*'],
      },
    },
  });

  await server.register(Inert);

  server.route({
    method: 'GET',
    path: '/',
    handler: async (request, h) => {
      const startTime = Date.now(); // Start timing

      // Ensure the correct model is set for each request
      await initializeModelIfNeeded(overrideModel);

      let { animal, color, personality } = request.query;

      let errors = [];

      if (!animal || !animals.includes(animal)) {
        errors.push({
          parameter: 'animal',
          message: `Invalid or missing animal parameter.`,
          valid_values: animals,
        });
      }

      if (!color || !colors.includes(color)) {
        errors.push({
          parameter: 'color',
          message: `Invalid or missing color parameter.`,
          valid_values: colors,
        });
      }

      if (!personality || !personalities.includes(personality)) {
        errors.push({
          parameter: 'personality',
          message: `Invalid or missing personality parameter.`,
          valid_values: personalities,
        });
      }

      if (errors.length > 0) {
        return h.response({ errors }).code(400);
      }

      const prompt = `A cute ${animal} against a solid fill background, taking up full-page. Its body is ${color}-colored, with an expression and stance conveying a ${personality} personality. Solid Blank background, collectable creature, very cute and kawaii illustration, whimsical chibi art, lofi anime art, kanto style, fantasy animal, pokemon-style. No words or signatures.`;

      const guideImagePath = path.join(animalsDir, `${animal}.jpg`);
      let blurredBuffer;
console.log('11');
      try {
        console.log('22');
        blurredBuffer = cache.get(`blurred_${path.basename(guideImagePath)}`);
        if (!blurredBuffer) {
          console.log('33');
          blurredBuffer = await blurImage(guideImagePath);
        }
      } catch (error) {
        console.error('Error retrieving blurred image:', error);
        return h.response({ error: 'Error processing guide image.' }).code(500);
      }

      try {
        console.log('44');
        const imageBuffer = await renderWithGuideImage(prompt, blurredBuffer);

        const endTime = Date.now(); // End timing
        const totalRequestTime = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`Total request processing time: ${totalRequestTime} seconds`);

        return h.response(imageBuffer)
          .type('image/png')
          .header('Content-Disposition', 'inline; filename="rendered_image.png"');
      } catch (error) {
        console.error('Error during image rendering:', error);
        return h.response({ error: 'Error rendering image.' }).code(500);
      }
    },
  });

  await server.start();
  console.log('Server running on %s', server.info.uri);
};

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});

init();
