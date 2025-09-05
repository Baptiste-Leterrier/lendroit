// Rate limiting configuration
const DEFAULT_MAX_REQUESTS = 3000000000;
const DEFAULT_WINDOW_SECONDS = 30000000000;
const IMAGE_MAX_REQUESTS = 10;
const IMAGE_WINDOW_SECONDS = 60;

export class RateLimiter {
  constructor(redis) {
    this.redis = redis;
    
    // Lua script for rate limiting using sliding window
    this.rateLimitScript = `
      local key = KEYS[1]
      local window = tonumber(ARGV[1])
      local limit = tonumber(ARGV[2])
      local current_time = tonumber(ARGV[3])
      
      -- Remove old entries outside the window
      redis.call('ZREMRANGEBYSCORE', key, '-inf', current_time - window * 1000)
      
      -- Count current entries
      local current = redis.call('ZCARD', key)
      
      if current < limit then
        -- Add current request
        redis.call('ZADD', key, current_time, current_time)
        redis.call('EXPIRE', key, window)
        return 1
      else
        return 0
      end
    `;
  }

  async checkRateLimit(key, maxRequests = DEFAULT_MAX_REQUESTS, windowSeconds = DEFAULT_WINDOW_SECONDS) {
    try {
      const currentTime = Date.now();
      const result = await this.redis.eval(
        this.rateLimitScript,
        1,
        key,
        windowSeconds,
        maxRequests,
        currentTime
      );
      
      return result === 1;
    } catch (error) {
      console.error('Rate limit error:', error);
      // Fail open - allow the request if there's an error
      return true;
    }
  }

  // Convenience method for pixel placement rate limiting
  async checkPixelRateLimit(key) {
    return this.checkRateLimit(key, DEFAULT_MAX_REQUESTS, DEFAULT_WINDOW_SECONDS);
  }

  // Convenience method for image upload rate limiting
  async checkImageRateLimit(key) {
    return this.checkRateLimit(key, IMAGE_MAX_REQUESTS, IMAGE_WINDOW_SECONDS);
  }

  async getRemainingRequests(key, maxRequests = DEFAULT_MAX_REQUESTS, windowSeconds = DEFAULT_WINDOW_SECONDS) {
    try {
      const currentTime = Date.now();
      await this.redis.zremrangebyscore(key, '-inf', currentTime - windowSeconds * 1000);
      const current = await this.redis.zcard(key);
      return Math.max(0, maxRequests - current);
    } catch (error) {
      console.error('Error getting remaining requests:', error);
      return maxRequests;
    }
  }

  async resetRateLimit(key) {
    try {
      await this.redis.del(key);
      return true;
    } catch (error) {
      console.error('Error resetting rate limit:', error);
      return false;
    }
  }
}