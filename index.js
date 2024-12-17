require('dotenv').config()
const Hapi = require('@hapi/hapi');
const Inert = require('@hapi/inert');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');
const NodeCache = require('node-cache');
const removeImageBackground = require('./lib/removeImageBackground');
const {SogniClient} = require("@sogni-ai/sogni-client");
const fs = require("node:fs");

// Configuration
const useInitImage = true; // Use guide images
let negativePrompt = '';
const blurLevel = 0; // Adjust as needed, set to 0 to disable
const overrideModel = 'coreml-animagineXLV31'; // Model to use
const steps = 32;
const guidance = 8; // Guidance
const startingImageStrength = 0.20;
const scheduler = 'DPM Solver Multistep (DPM-Solver++)';
const timeStepSpacing = 'Karras';
const removeBackground = true; // Set to false to disable background removal

const animals = [
  "ant", "bear", "bee", "butterfly", "caterpillar", "cat", "crab", "crocodile",
  "deer", "dog", "dolphin", "dragon", "dragonfly", "eagle", "elephant", "fish",
  "fox", "giraffe", "gorilla", "horse", "jellyfish", "kangaroo", "koala",
  "ladybug", "lion", "lobster", "mantis", "monkey", "octopus", "owl", "panda",
  "penguin", "rabbit", "scorpion", "seal", "seahorse", "shark", "shrimp",
  "squid", "squirrel", "starfish", "spider", "tiger", "turtle", "whale", "zebra"
];
const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'black', 'white', 'grey', 'brown'];
const personalities = ['loyal', 'courageous', 'free-spirited', 'majestic', 'wise', 'energetic', 'curious', 'icy', 'fiery', 'psychic', 'degen', 'fairy', 'fighting', 'techno'];

const animalsDir = path.join(__dirname, 'animals'); // Guide images directory

// Initialize cache
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour TTL

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

/**
 * Wrapper function to await project completion
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

// Initialize the Hapi server
const init = async () => {
  const sogni = await SogniClient.createInstance({
    appId: process.env.APP_ID,
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
  /*sogni.projects.on('availableModels', (models)=>{
    console.log('Available models:', models);
  });*/

  await sogni.account.login(process.env.SOGNI_USERNAME, process.env.SOGNI_PASSWORD);

  const server = Hapi.server({
    port: 8084,
    host: '0.0.0.0',
    routes: {
      cors: {
        origin: ['*'],
      },
    },
  });

  await server.register(Inert);

  // Heartbeat route
  server.route({
    method: 'GET',
    path: '/heartbeat',
    handler: (request, h) => {
      return h.response('1').code(200);
    },
  });

  server.route({
    method: 'GET',
    path: '/',
    handler: async (request, h) => {
      const startTime = Date.now(); // Start timing
      const sendResult = (resultingImage)=> {
        const endTime = Date.now(); // End timing
        const totalRequestTime = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`Total request processing time: ${totalRequestTime} seconds`);
        return h.response(resultingImage)
            .type('image/png')
            .header('Content-Disposition', 'inline; filename="rendered_image.png"');
      }

      const sendError = (message) => {
        return h.response({ error: message }).code(500);
      }

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

      const prompt = `((one ${animal})), cute, full size, against a (solid fill background). ${color}-colored body, with an expression and stance conveying a ${personality} personality. Solid Blank background, collectable creature, very cute and kawaii illustration, whimsical chibi art, lofi anime art, kanto style, semi-realistic fantasy animal, pokemon-style`;
      negativePrompt = `((many ${animal})), malformation, bad anatomy, bad hands, missing fingers, cropped, low quality, bad quality, jpeg artifacts, watermark, text, (more than one character), multiple heads, ((multiple animals)), shadows, borders, (incomplete character), multi-color background`;

      //const prompt = `A cute ${animal} against a solid fill background, taking up full-page. Its body is ${color}-colored, with an expression and stance conveying a ${personality} personality. Solid Blank background, collectable creature, very cute and kawaii illustration, whimsical chibi art, lofi anime art, kanto style, fantasy animal, pokemon-style. No words or signatures.`;
      const guideImagePath = path.join(animalsDir, `${animal}.png`);
      let startingImage;
      if(blurLevel > 0){
        try {
          startingImage = cache.get(`blurred_${path.basename(guideImagePath)}`);
          if (!startingImage) {
            startingImage = await blurImage(guideImagePath);
          }
        } catch (error) {
          console.error('Error retrieving blurred image:', error);
          return sendError('Error processing guide image.');
        }
      } else {
        startingImage = fs.readFileSync(guideImagePath);
      }

      try {
        // Project params interface here https://github.com/Sogni-AI/sogni-client/blob/bf4b8e3176bafbcb61a93329b497ba980cb7a8ca/src/Projects/types/index.ts#L46
        const project = await sogni.projects.create({
          modelId: overrideModel,
          positivePrompt: prompt,
          steps,
          guidance,
          numberOfImages: 1,
          startingImage,
          startingImageStrength,
          scheduler,
          timeStepSpacing
        })
        const [imageUrl] = await waitProjectCompletion(project);

        //No need to remove background, send the image as is
        if(!removeBackground){
          const imageStream = await axios.get(imageUrl, { responseType: 'stream' });
          return sendResult(imageStream.data);
        }

        // Process the image to remove background color
        const imageBuffer = await axios.get(imageUrl, { responseType: 'arraybuffer' }).then((response) => response.data);
        try {
          const resultingImage = await removeImageBackground(imageBuffer);
          return sendResult(resultingImage);
        } catch (err) {
          console.error('Error processing image:', err);
          return sendError('Error processing image.');
        }
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
