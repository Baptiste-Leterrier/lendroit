export class TileManager {
  constructor(redis, tileSize, canvasWidth, canvasHeight) {
    this.redis = redis;
    this.tileSize = tileSize;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.tilesX = Math.ceil(canvasWidth / tileSize);
    this.tilesY = Math.ceil(canvasHeight / tileSize);
    
    // Lua script for atomic pixel updates
    this.setPixelScript = `
      local tileKey = KEYS[1]
      local pixelIndex = tonumber(ARGV[1])
      local r = tonumber(ARGV[2])
      local g = tonumber(ARGV[3])
      local b = tonumber(ARGV[4])
      local a = tonumber(ARGV[5])
      
      -- Get existing tile data or create empty tile
      local tileData = redis.call('GET', tileKey)
      if not tileData then
        -- Create empty tile (256x256x4 = 262144 bytes, all white pixels)
        tileData = string.rep(string.char(255, 255, 255, 255), 65536)
      end
      
      -- Update pixel at index (4 bytes per pixel: RGBA)
      local byteIndex = (pixelIndex * 4) + 1
      local newPixel = string.char(r, g, b, a)
      tileData = string.sub(tileData, 1, byteIndex - 1) .. newPixel .. string.sub(tileData, byteIndex + 4)
      
      -- Store updated tile
      redis.call('SET', tileKey, tileData)
      return 1
    `;
  }

  async initializeTiles() {
    // Check if tiles are already initialized
    const exists = await this.redis.exists('tiles:initialized');
    if (exists) {
      console.log('Tiles already initialized');
      return;
    }

    console.log(`Initializing ${this.tilesX * this.tilesY} tiles...`);
    
    // Mark as initialized to avoid re-initialization
    await this.redis.set('tiles:initialized', '1');
    console.log('Tile initialization complete');
  }

  getTileId(tileX, tileY) {
    return `tile:${tileX}:${tileY}`;
  }

  coordsToTile(x, y) {
    return {
      tileX: Math.floor(x / this.tileSize),
      tileY: Math.floor(y / this.tileSize),
      localX: x % this.tileSize,
      localY: y % this.tileSize
    };
  }

  hexToRgba(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b, a: 255 };
  }

  async setPixel(x, y, color) {
    try {
      const { tileX, tileY, localX, localY } = this.coordsToTile(x, y);
      const tileId = this.getTileId(tileX, tileY);
      const { r, g, b, a } = this.hexToRgba(color);
      
      // Calculate pixel index within tile
      const pixelIndex = localY * this.tileSize + localX;
      
      // Use Lua script for atomic update
      const result = await this.redis.eval(
        this.setPixelScript,
        1,
        tileId,
        pixelIndex,
        r,
        g,
        b,
        a
      );
      
      return result === 1;
    } catch (error) {
      console.error('Error setting pixel:', error);
      return false;
    }
  }

  async getTile(tileX, tileY) {
    try {
      const tileId = this.getTileId(tileX, tileY);
      const tileData = await this.redis.getBuffer(tileId);
      
      if (!tileData) {
        // Return empty white tile
        const emptyTile = Buffer.alloc(this.tileSize * this.tileSize * 4);
        emptyTile.fill(255); // White pixels
        return {
          tileX,
          tileY,
          data: emptyTile.toString('base64')
        };
      }
      
      return {
        tileX,
        tileY,
        data: tileData.toString('base64')
      };
    } catch (error) {
      console.error('Error getting tile:', error);
      return null;
    }
  }

  async getTiles(tileIds) {
    const tiles = [];
    
    for (const tileId of tileIds) {
      const [, tileX, tileY] = tileId.split(':').map(Number);
      if (tileX >= 0 && tileX < this.tilesX && tileY >= 0 && tileY < this.tilesY) {
        const tile = await this.getTile(tileX, tileY);
        if (tile) {
          tiles.push(tile);
        }
      }
    }
    
    return tiles;
  }

  async getVisibleTiles(viewX, viewY, viewWidth, viewHeight) {
    const startTileX = Math.floor(viewX / this.tileSize);
    const endTileX = Math.ceil((viewX + viewWidth) / this.tileSize);
    const startTileY = Math.floor(viewY / this.tileSize);
    const endTileY = Math.ceil((viewY + viewHeight) / this.tileSize);
    
    const tiles = [];
    
    for (let tileY = startTileY; tileY < endTileY; tileY++) {
      for (let tileX = startTileX; tileX < endTileX; tileX++) {
        if (tileX >= 0 && tileX < this.tilesX && tileY >= 0 && tileY < this.tilesY) {
          const tile = await this.getTile(tileX, tileY);
          if (tile) {
            tiles.push(tile);
          }
        }
      }
    }
    
    return tiles;
  }

  async getFullSnapshot() {
    const snapshot = {};
    
    for (let tileY = 0; tileY < this.tilesY; tileY++) {
      for (let tileX = 0; tileX < this.tilesX; tileX++) {
        const tileId = this.getTileId(tileX, tileY);
        const tileData = await this.redis.getBuffer(tileId);
        if (tileData) {
          snapshot[tileId] = tileData.toString('base64');
        }
      }
    }
    
    return snapshot;
  }

  getTileInfo() {
    return {
      tileSize: this.tileSize,
      tilesX: this.tilesX,
      tilesY: this.tilesY,
      canvasWidth: this.canvasWidth,
      canvasHeight: this.canvasHeight
    };
  }
}