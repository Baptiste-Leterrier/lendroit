import uWS from 'uWebSockets.js';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { TileManager } from './tile-manager.js';
import { RateLimiter } from './rate-limiter.js';

const PORT = process.env.PORT || 9001;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/canvas';

// Canvas configuration
const CANVAS_WIDTH = 4000;
const CANVAS_HEIGHT = 4000;
const TILE_SIZE = 256;

class PlaceServer {
  constructor() {
    this.redis = new Redis(REDIS_URL);
    this.redisPub = new Redis(REDIS_URL);
    this.redisSub = new Redis(REDIS_URL);
    this.mongo = null;
    this.tileManager = new TileManager(this.redis, TILE_SIZE, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.rateLimiter = new RateLimiter(this.redis);
    this.clients = new Map();
    this.app = null;
    this.activeImageDrawings = new Map(); // Track active image drawing processes
    this.imageChunks = new Map(); // Track incoming image chunks
    
    this.init();
  }

  async init() {
    try {
      // Connect to MongoDB
      const mongoClient = new MongoClient(MONGO_URL);
      await mongoClient.connect();
      this.mongo = mongoClient.db('canvas');
      console.log('Connected to MongoDB');

      // Setup Redis pub/sub
      await this.redisSub.subscribe('canvas:updates');
      this.redisSub.on('message', (channel, message) => {
        if (channel === 'canvas:updates') {
          this.broadcastUpdate(message);
        }
      });

      // Initialize tiles in Redis if needed
      await this.tileManager.initializeTiles();
      
      console.log('Connected to Redis');
      this.startServer();
    } catch (error) {
      console.error('Failed to initialize:', error);
      process.exit(1);
    }
  }

  startServer() {
    try {
      this.app = uWS.App({
        compression: uWS.SHARED_COMPRESSOR,
        maxCompressedSize: 1024 * 1024, // 1MB
        maxBackpressure: 1024 * 1024     // 1MB
      }).ws('/*', {
      maxPayloadLength: 1024 * 1024,   // 1MB for large image data
      message: (ws, message, opCode) => {
        this.handleMessage(ws, message);
      },
      open: (ws) => {
        const clientId = uuidv4();
        ws.clientId = clientId;
        this.clients.set(clientId, ws);
        console.log(`Client connected: ${clientId}`);
      },
      close: (ws) => {
        if (ws.clientId) {
          this.clients.delete(ws.clientId);
          
          // Stop any active image drawing for this client
          const userKey = ws.remoteAddress || ws.clientId;
          const drawingProcess = this.activeImageDrawings.get(userKey);
          if (drawingProcess) {
            clearInterval(drawingProcess.intervalId);
            this.activeImageDrawings.delete(userKey);
          }
          
          // Clean up any pending image chunks from this client
          for (const [imageId, chunkData] of this.imageChunks.entries()) {
            if (chunkData.userKey === userKey) {
              this.imageChunks.delete(imageId);
              console.log(`Cleaned up incomplete image chunks for ${imageId}`);
            }
          }
          
          console.log(`Client disconnected: ${ws.clientId}`);
        }
      }
    }).listen('0.0.0.0', PORT, (token) => {
      if (token) {
        console.log(`Place server listening on 0.0.0.0:${PORT}`);
      } else {
        console.error('Failed to start server - port may be in use or permission denied');
        console.error(`Attempted to bind to 0.0.0.0:${PORT}`);
        process.exit(1);
      }
    });
    } catch (error) {
      console.error('Error creating server:', error);
      process.exit(1);
    }
  }

  async handleMessage(ws, message) {
    try {
      const data = JSON.parse(Buffer.from(message).toString());
      const clientId = ws.clientId;
      
      switch (data.type) {
        case 'set_pixel':
          await this.handleSetPixel(ws, data, clientId);
          break;
        case 'get_tiles':
          await this.handleGetTiles(ws, data);
          break;
        case 'place_image':
          await this.handlePlaceImage(ws, data, clientId);
          break;
        case 'place_image_chunk':
          await this.handlePlaceImageChunk(ws, data, clientId);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        default:
          console.warn(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  }

  async handleSetPixel(ws, data, clientId) {
    const { x, y, color } = data;
    
    // Validate coordinates
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
      ws.send(JSON.stringify({ type: 'error', message: 'Coordinates out of bounds' }));
      return;
    }

    // Validate color format (hex)
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid color format' }));
      return;
    }

    // Rate limiting
    const rateLimitKey = `rate_limit:${ws.remoteAddress || clientId}`;
    const isAllowed = await this.rateLimiter.checkPixelRateLimit(rateLimitKey);
    if (!isAllowed) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
      return;
    }

    try {
      // Update tile and broadcast
      const success = await this.tileManager.setPixel(x, y, color);
      if (success) {
        // Publish update to Redis pub/sub
        const update = {
          type: 'pixel_update',
          x,
          y,
          color,
          timestamp: Date.now(),
          clientId
        };
        
        await this.redisPub.publish('canvas:updates', JSON.stringify(update));
        
        // Confirm to sender
        ws.send(JSON.stringify({ type: 'pixel_set', x, y, color }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to set pixel' }));
      }
    } catch (error) {
      console.error('Error setting pixel:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Server error' }));
    }
  }

  async handleGetTiles(ws, data) {
    const { tileIds } = data;
    
    if (!Array.isArray(tileIds)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid tile request' }));
      return;
    }

    try {
      const tiles = await this.tileManager.getTiles(tileIds);
      ws.send(JSON.stringify({
        type: 'tiles',
        tiles
      }));
    } catch (error) {
      console.error('Error getting tiles:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to get tiles' }));
    }
  }

  async handlePlaceImage(ws, data, clientId) {
    console.log('Received place_image request:', { 
      startX: data.startX, 
      startY: data.startY, 
      pixelCount: data.pixels?.length,
      clientId 
    });
    
    const { startX, startY, pixels } = data;
    
    // Validate input
    if (!Array.isArray(pixels) || pixels.length === 0) {
      console.error('Invalid pixels array:', pixels);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid image data' }));
      return;
    }

    if (!Number.isInteger(startX) || !Number.isInteger(startY)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid start coordinates' }));
      return;
    }

    // Check if user already has an active image drawing
    const userKey = ws.remoteAddress || clientId;
    if (this.activeImageDrawings.has(userKey)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Already drawing an image. Please wait.' }));
      return;
    }

    // Validate all pixels are within bounds
    for (const pixel of pixels) {
      // Handle both object format {x, y, color} and array format [x, y, color]
      const px = Array.isArray(pixel) ? pixel[0] : pixel.x;
      const py = Array.isArray(pixel) ? pixel[1] : pixel.y;
      const color = Array.isArray(pixel) ? pixel[2] : pixel.color;
      
      const finalX = startX + px;
      const finalY = startY + py;
      
      if (finalX < 0 || finalX >= CANVAS_WIDTH || finalY < 0 || finalY >= CANVAS_HEIGHT) {
        ws.send(JSON.stringify({ type: 'error', message: 'Image extends outside canvas bounds' }));
        return;
      }

      // Validate color format
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid color format in image' }));
        return;
      }
    }

    // Rate limiting for image placement (less strict than individual pixels)
    const rateLimitKey = `image_rate_limit:${userKey}`;
    const isAllowed = await this.rateLimiter.checkImageRateLimit(rateLimitKey);
    if (!isAllowed) {
      ws.send(JSON.stringify({ type: 'error', message: 'Image upload rate limit exceeded' }));
      return;
    }

    // Start drawing the image
    this.startImageDrawing(ws, clientId, userKey, startX, startY, pixels);
    
    // Confirm start
    ws.send(JSON.stringify({ 
      type: 'image_drawing_started', 
      totalPixels: pixels.length,
      estimatedSeconds: Math.ceil(pixels.length / 1000)
    }));
  }

  async handlePlaceImageChunk(ws, data, clientId) {
    const { imageId, chunkIndex, totalChunks, startX, startY, pixels } = data;
    
    console.log(`Received chunk ${chunkIndex + 1}/${totalChunks} for image ${imageId} (${pixels.length} pixels)`);
    
    // Validate chunk data
    if (!imageId || chunkIndex === undefined || !totalChunks || !Array.isArray(pixels)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid chunk data' }));
      return;
    }
    
    const userKey = ws.remoteAddress || clientId;
    
    // Initialize chunk collection for this image
    if (!this.imageChunks.has(imageId)) {
      this.imageChunks.set(imageId, {
        chunks: new Array(totalChunks),
        receivedChunks: 0,
        startX,
        startY,
        userKey,
        ws,
        clientId,
        timestamp: Date.now()
      });
    }
    
    const chunkData = this.imageChunks.get(imageId);
    
    // Validate this chunk belongs to the same user
    if (chunkData.userKey !== userKey) {
      ws.send(JSON.stringify({ type: 'error', message: 'Chunk belongs to different user' }));
      return;
    }
    
    // Store the chunk
    if (!chunkData.chunks[chunkIndex]) {
      chunkData.chunks[chunkIndex] = pixels;
      chunkData.receivedChunks++;
      
      // Send progress
      ws.send(JSON.stringify({
        type: 'image_chunk_received',
        imageId,
        chunksReceived: chunkData.receivedChunks,
        totalChunks
      }));
      
      // Check if all chunks received
      if (chunkData.receivedChunks === totalChunks) {
        console.log(`All chunks received for image ${imageId}, assembling...`);
        
        // Assemble all chunks into one pixel array
        const allPixels = [];
        for (const chunk of chunkData.chunks) {
          if (chunk) {
            allPixels.push(...chunk);
          }
        }
        
        console.log(`Assembled image: ${allPixels.length} pixels`);
        
        // Clean up chunk data
        this.imageChunks.delete(imageId);
        
        // Process as a regular image
        await this.handlePlaceImage(ws, {
          startX: chunkData.startX,
          startY: chunkData.startY,
          pixels: allPixels
        }, clientId);
      }
    }
  }

  startImageDrawing(ws, clientId, userKey, startX, startY, pixels) {
    const drawingId = `${userKey}_${Date.now()}`;
    
    const drawingProcess = {
      ws,
      clientId,
      pixels,
      startX,
      startY,
      currentIndex: 0,
      totalPixels: pixels.length,
      intervalId: null
    };

    this.activeImageDrawings.set(userKey, drawingProcess);

    // Process pixels in batches of 50 at 50ms intervals (1000 pixels per second)
    const batchSize = 50;
    drawingProcess.intervalId = setInterval(async () => {
      if (drawingProcess.currentIndex >= drawingProcess.totalPixels) {
        // Drawing complete
        clearInterval(drawingProcess.intervalId);
        this.activeImageDrawings.delete(userKey);
        
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'image_drawing_complete',
            pixelsPlaced: drawingProcess.totalPixels
          }));
        }
        return;
      }

      // Process a batch of pixels
      const endIndex = Math.min(drawingProcess.currentIndex + batchSize, drawingProcess.totalPixels);
      const pixelUpdates = [];

      for (let i = drawingProcess.currentIndex; i < endIndex; i++) {
        const pixel = drawingProcess.pixels[i];
        // Handle both object format {x, y, color} and array format [x, y, color]
        const px = Array.isArray(pixel) ? pixel[0] : pixel.x;
        const py = Array.isArray(pixel) ? pixel[1] : pixel.y;
        const color = Array.isArray(pixel) ? pixel[2] : pixel.color;
        
        const finalX = startX + px;
        const finalY = startY + py;

        try {
          const success = await this.tileManager.setPixel(finalX, finalY, color);
          if (success) {
            pixelUpdates.push({
              type: 'pixel_update',
              x: finalX,
              y: finalY,
              color: color,
              timestamp: Date.now(),
              clientId,
              fromImage: true
            });
          }
        } catch (error) {
          console.error('Error placing image pixel:', error);
        }
      }

      // Publish all updates in batch
      for (const update of pixelUpdates) {
        try {
          await this.redisPub.publish('canvas:updates', JSON.stringify(update));
        } catch (error) {
          console.error('Error publishing pixel update:', error);
        }
      }

      drawingProcess.currentIndex = endIndex;

      // Send progress update every 500 pixels
      if (drawingProcess.currentIndex % 500 === 0 && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'image_drawing_progress',
          pixelsPlaced: drawingProcess.currentIndex,
          totalPixels: drawingProcess.totalPixels,
          progress: Math.round((drawingProcess.currentIndex / drawingProcess.totalPixels) * 100)
        }));
      }
    }, 50); // 50ms intervals with 50 pixels each = 1000 pixels/second
  }

  broadcastUpdate(message) {
    if (this.clients.size === 0) return;

    const updateBuffer = Buffer.from(message);
    this.clients.forEach((ws) => {
      try {
        ws.send(updateBuffer);
      } catch (error) {
        console.error('Error broadcasting to client:', error);
      }
    });
  }

  async saveSnapshot() {
    try {
      const snapshot = await this.tileManager.getFullSnapshot();
      await this.mongo.collection('snapshots').insertOne({
        timestamp: new Date(),
        snapshot
      });
      console.log('Snapshot saved to MongoDB');
    } catch (error) {
      console.error('Error saving snapshot:', error);
    }
  }
}

// Start server
const server = new PlaceServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  if (server.app) {
    server.app.close();
  }
  process.exit(0);
});

// Save snapshots periodically (every 5 minutes)
setInterval(() => {
  server.saveSnapshot();
}, 5 * 60 * 1000);