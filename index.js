require('dotenv').config()
const fs = require('node:fs');
const Hapi = require('@hapi/hapi');
const Inert = require('@hapi/inert');
const axios = require('axios');
const sharp = require('sharp');
const path = require('node:path');
const NodeCache = require('node-cache');
const {SogniClient} = require('@sogni-ai/sogni-client');

// Configuration
const blurLevel = 40; // Adjust as needed

const animals = ['bee', 'crocodile', 'dog', 'jellyfish', 'koala', 'panda', 'scorpion', 'tiger'];
const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'black', 'white', 'grey', 'brown'];
const personalities = ['loyal', 'courageous', 'free-spirited', 'majestic', 'wise', 'energetic', 'curious', 'icy', 'fiery', 'psychic', 'degen', 'fairy', 'fighting', 'techno'];

/**
 * Specify list of preferred models to use, in order of preference with default parameters.
 * Parameters vary between models greatly, so need to find optimal parameters for each model.
 * @type {Array<{modelId: string, guidance: number, id: string, steps: number, startingImageStrength: number, blurStartingImage: boolean}>}
 */
const modelPresets = [
  /**
   * Flux seems to have very different parameters, so we need to move most parameters here.
   * One of differences is that blurred guide image result in a blurry output image.
   */
  {
    modelId: 'flux1-schnell-fp8',
    steps: 4,
    guidance: 1,
    startingImageStrength: 0.2,
    blurStartingImage: false
  },
  {
    modelId: 'coreml-sogni_artist_v1_768',
    steps: 20,
    guidance: 7.5,
    startingImageStrength: 0.5,
    blurStartingImage: true
  }
];

const animalsDir = path.join(__dirname, 'animals'); // Guide images directory

// Initialize cache
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour TTL

/**
 * Seelct first available model from the list of model presets
 * @param availableModels - sogni.projects.availableModels
 * @returns {null|{modelId: string, guidance: number, id: string, steps: number, startingImageStrength: number, blurStartingImage: boolean}}
 */
function getModelPreset(availableModels){
  for(let model of modelPresets){
    if(availableModels.some((m)=>m.id === model.modelId)){
      return model;
    }
  }
  return null;
}

/**
 * Simple wrapper function to await project completion
 * @param project - Sogni project instance
 * @returns {Promise<Array<string>>} - Promise that resolves with the image URL array
 */
function waitProjectCompletion(project){
  return new Promise((resolve, reject)=>{
    project.on('completed', (data)=>{
      resolve(data);
    });
    project.on('failed', (data)=>{
      reject(data);
    });
  });
}

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

// Initialize the Hapi server
const init = async () => {
  const sogni = await SogniClient.createInstance({
    appId: 'sogni-creatures',
    restEndpoint: 'https://api.sogni.ai',
    socketEndpoint: 'https://socket.sogni.ai',
    testnet: true,
    network: 'fast'
  });

  sogni.apiClient.on('connected', ()=>{
    console.log('Connected to Sogni API');
  })

  sogni.apiClient.on('disconnected', ({code, reason})=>{
    console.error('Disconnected from Sogni API', code, reason);
    setTimeout(()=>{
      process.exit(1);
    }, 100);
  });

  //Fired every time server sends list of available models
  sogni.projects.on('availableModels', (models)=>{
    console.log('Available models:', models);
  });

  await sogni.account.login(process.env.SOGNI_USERNAME, process.env.SOGNI_PASSWORD);

  setInterval(()=>{
    sogni.account
        .login(process.env.SOGNI_USERNAME, process.env.SOGNI_PASSWORD)
        .then(() => {
          console.log('Re-login successful');
        })
        .catch((error) => {
            console.error('Re-login failed:', error);
            process.exit(1);
        });
  }, 1000 * 60 * 60 * 23); // Re-login every 24 hours

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
      let startingImage;

      const preset = getModelPreset(sogni.projects.availableModels);
      if(!preset){
        console.error('No model available');
        return h.response({ error: 'No model available.' }).code(500);
      }

      try {
        startingImage = preset.blurStartingImage ? await blurImage(guideImagePath) : fs.readFileSync(guideImagePath);
      } catch (error) {
        console.error('Error retrieving blurred image:', error);
        return h.response({ error: 'Error processing guide image.' }).code(500);
      }

      try {
        // Project params interface here https://github.com/Sogni-AI/sogni-client/blob/bf4b8e3176bafbcb61a93329b497ba980cb7a8ca/src/Projects/types/index.ts#L46
        const project = await sogni.projects.create({
          modelId: preset.modelId,
          positivePrompt: prompt,
          steps: preset.steps,
          guidance: preset.guidance,
          numberOfImages: 1,
          startingImage: startingImage,
          startingImageStrength: preset.startingImageStrength
        })
        const [imageUrl] = await waitProjectCompletion(project);
        const endTime = Date.now(); // End timing
        const totalRequestTime = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`Total request processing time: ${totalRequestTime} seconds`);
        // Stream the image back to the client
        const imageStream = await axios.get(imageUrl, { responseType: 'stream' });
        return h.response(imageStream.data).code(200);
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
