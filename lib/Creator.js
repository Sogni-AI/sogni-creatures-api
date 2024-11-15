const {SogniClient} = require("@sogni-ai/sogni-client");

async function initSogni(appId, username, password) {
    console.log('Initializing Sogni API client', appId);
    const sogni = await SogniClient.createInstance({
        appId,
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

    await sogni.account.login(username, password);
    return sogni;
}

class Creator {
    queue = [];

    isIdle = true;

    get isIdle() {
        return this.queue.length === 0;
    }

    constructor(appId, login, password) {
        this.sogni = initSogni(appId, login, password);
    }

    /**
     * Process request
     * @param projectParams
     * @returns {Promise<string>} - Promise that resolves with the image URL
     */
    async processRequest(projectParams) {
        const jobPromise =  new Promise(async (resolve, reject) => {
           this.queue.push({
               params: projectParams,
                resolve,
                reject
           })
        });
        this._moveQueue()
        return jobPromise;
    }

    async _moveQueue() {
        if(!this.isIdle || this.queue.length === 0) {
            return;
        }

        this.isIdle = false;
        const job = this.queue.shift();
        try {
            const sogni = await this.sogni;
            const project = await sogni.projects.create(job.params);
            const images = await project.waitForCompletion();
            job.resolve(images[0]);
        } catch (e) {
            job.reject(e);
        }
        this.isIdle = true;
        this._moveQueue();
    }


}

module.exports = Creator;
