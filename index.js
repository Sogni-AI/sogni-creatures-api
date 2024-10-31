const Hapi = require('@hapi/hapi');
const Inert = require('@hapi/inert');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Configuration
const apiUrl = 'http://localhost:7860/';
const useInitImage = false;  // Use guide images
const rendersDir = path.join(__dirname, 'renders');
const animalsDir = path.join(__dirname, 'animals');

const negativePrompt = 'malformation, bad anatomy, bad hands, missing fingers, cropped, low quality, bad quality, jpeg artifacts, watermark, text, more than one character, multiple heads, multiple faces, shadow, borders, background';
const blurLevel = 40;  // Adjust as needed
const overrideModel = 'animagineXLV31_v31';  // Model to use
const steps = 35;
const cfgScale = 9;  // Guidance
const resolution = { width: 1024, height: 1024 };
const denoisingStrength = 0.75;
//const seed = 4128984066;
const sampler = 'Euler a';
const scheduler = 'Karras';

const animals = ['bee', 'crocodile', 'dog', 'jellyfish', 'koala', 'panda', 'scorpion', 'tiger'];
const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'black', 'white', 'grey', 'brown'];
const personalities = ['loyal', 'courageous', 'free-spirited', 'majestic', 'wise', 'energetic', 'curious', 'icy', 'fiery', 'psychic', 'degen', 'fairy', 'fighting', 'techno'];

// Ensure renders folder exists
if (!fs.existsSync(rendersDir)) {
  fs.mkdirSync(rendersDir);
}

// Function to blur the image by specified level
async function blurImage(inputPath, outputPath) {
  try {
    await sharp(inputPath)
      .blur(blurLevel)
      .toFile(outputPath);
    console.log(`Image blurred successfully: ${inputPath}`);
  } catch (error) {
    console.error(`Error blurring image: ${inputPath}`, error);
  }
}

// Function to switch the model
async function switchModel(model) {
  try {
    await axios.post(`${apiUrl}sdapi/v1/options`, {
      sd_model_checkpoint: model
    });
    console.log(`Switched to model: ${model}`);
    await new Promise(resolve => setTimeout(resolve, 5000)); // Add a 5-second delay
  } catch (error) {
    console.error(`Error switching model to ${model}:`, error);
  }
}

// Function to send the request to the API
async function renderWithGuideImage(prompt, guideImagePath, outputFilePath) {
  try {
    // Switch to the appropriate model
    await switchModel(overrideModel);

    // Read the blurred image and convert to base64 if using init_images
    let initImages = [];
    if (useInitImage) {
      const blurredImage = fs.readFileSync(guideImagePath, { encoding: 'base64' });
      initImages = [`data:image/jpeg;base64,${blurredImage}`];
      console.log('Using guide image for rendering...');
    } else {
      console.log('Rendering without guide image...');
    }

    const requestData = {
      prompt: prompt,
      negative_prompt: negativePrompt,
      steps: steps,
      cfg_scale: cfgScale,
      width: resolution.width,
      height: resolution.height,
      sampler_name: sampler,
      scheduler: scheduler,
      //seed: seed,
      denoising_strength: denoisingStrength,
      ...(useInitImage && { init_images: initImages }),
    };

    console.log(`Sending rendering request for prompt: "${prompt}"`);

    const startTime = Date.now();

    // Make the API call
    const response = await axios.post(`${apiUrl}sdapi/v1/${useInitImage ? 'img2img' : 'txt2img'}`, requestData);

    const endTime = Date.now();
    const renderTimeInSeconds = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`Rendering complete. Time taken: ${renderTimeInSeconds} seconds.`);

    // Save the output image
    const imageBase64 = response.data.images[0];
    fs.writeFileSync(outputFilePath, Buffer.from(imageBase64, 'base64'));
    console.log(`Saved image to ${outputFilePath}`);
  } catch (error) {
    console.error('Error rendering image:', error);
  }
}

// Initialize the Hapi server
const init = async () => {
  const server = Hapi.server({
    port: 8080,
    host: '0.0.0.0' // Listen on all network interfaces
  });

  await server.register(Inert);

  // Route to handle GET requests
  server.route({
    method: 'GET',
    path: '/',
    handler: async (request, h) => {
      let { animal, color, personality } = request.query;

      // Collect errors
      let errors = [];

      if (!animal || !animals.includes(animal)) {
        errors.push({
          parameter: 'animal',
          message: `Invalid or missing animal parameter.`,
          valid_values: animals
        });
      }

      if (!color || !colors.includes(color)) {
        errors.push({
          parameter: 'color',
          message: `Invalid or missing color parameter.`,
          valid_values: colors
        });
      }

      if (!personality || !personalities.includes(personality)) {
        errors.push({
          parameter: 'personality',
          message: `Invalid or missing personality parameter.`,
          valid_values: personalities
        });
      }

      // If there are any errors, respond with a 400 Bad Request
      if (errors.length > 0) {
        return h.response({ errors }).code(400);
      }

      // Build the prompt
      const prompt = `A cute ${animal} against a solid fill background. Its body is ${color}-colored, with an expression and stance conveying a ${personality} personality. Solid Blank background, collectable creature, very cute and kawaii illustration, whimsical chibi art, lofi anime art, kanto style, semi-realistic fantasy animal, pokemon-style`;

      // Get the guide image path
      const guideImagePath = path.join(animalsDir, `${animal}.jpg`);
      const blurredGuideImagePath = path.join(animalsDir, `blurred_${animal}.jpg`);

      // Blur the guide image if not already blurred
      if (!fs.existsSync(blurredGuideImagePath)) {
        await blurImage(guideImagePath, blurredGuideImagePath);
      }

      // Render the image
      const imageFilename = `${animal}_${Date.now()}.png`;
      const outputFilePath = path.join(rendersDir, imageFilename);

      await renderWithGuideImage(prompt, blurredGuideImagePath, outputFilePath);

      // Return the image file
      return h.file(outputFilePath);
    }
  });

  // Start the server
  await server.start();
  console.log('Server running on %s', server.info.uri);
};

init();
