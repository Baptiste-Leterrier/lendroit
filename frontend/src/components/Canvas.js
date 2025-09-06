import React, { useEffect, useRef, useState, useCallback } from 'react';

const CANVAS_WIDTH = 4000;
const CANVAS_HEIGHT = 4000;
const TILE_SIZE = 256;
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

function Canvas({ ws, selectedColor, onPixelPlace, rateLimited, imageMode, pendingImage, onImagePlace }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [scale, setScale] = useState(0.5);
  const [offset, setOffset] = useState({ x: -CANVAS_WIDTH / 4, y: -CANVAS_HEIGHT / 4 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [tiles, setTiles] = useState(new Map());
  const [loadedTiles, setLoadedTiles] = useState(new Set());
  
  const offscreenCanvasRef = useRef(null);
  const offscreenCtxRef = useRef(null);

  // Initialize offscreen canvas
  useEffect(() => {
    const offscreenCanvas = new OffscreenCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const offscreenCtx = offscreenCanvas.getContext('2d');
    
    // Disable anti-aliasing for crisp pixels
    offscreenCtx.imageSmoothingEnabled = false;
    offscreenCtx.webkitImageSmoothingEnabled = false;
    offscreenCtx.mozImageSmoothingEnabled = false;
    offscreenCtx.msImageSmoothingEnabled = false;
    
    offscreenCtxRef.current = offscreenCtx;
    offscreenCanvasRef.current = offscreenCanvas;
    
    // Fill with white background
    offscreenCtx.fillStyle = '#ffffff';
    offscreenCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }, []);

  // Handle WebSocket messages
  useEffect(() => {
    if (!ws) return;

    const handleMessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'pixel_update') {
        updatePixel(data.x, data.y, data.color);
      } else if (data.type === 'tiles') {
        loadTileData(data.tiles);
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws]);

  // Use refs to avoid circular dependencies
  const requestRedrawRef = useRef();

  const updatePixel = useCallback((x, y, color) => {
    if (!offscreenCtxRef.current) return;
    
    const ctx = offscreenCtxRef.current;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
    
    // Trigger redraw without changing zoom/pan
    if (requestRedrawRef.current) {
      requestRedrawRef.current();
    }
  }, []);

  const loadTileData = useCallback((tilesData) => {
    if (!offscreenCtxRef.current) return;
    
    const ctx = offscreenCtxRef.current;
    
    tilesData.forEach(tile => {
      try {
        const imageData = new ImageData(
          new Uint8ClampedArray(atob(tile.data).split('').map(c => c.charCodeAt(0))),
          TILE_SIZE,
          TILE_SIZE
        );
        
        const tileCanvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
        const tileCtx = tileCanvas.getContext('2d');
        
        // Disable anti-aliasing for crisp pixels
        tileCtx.imageSmoothingEnabled = false;
        tileCtx.webkitImageSmoothingEnabled = false;
        tileCtx.mozImageSmoothingEnabled = false;
        tileCtx.msImageSmoothingEnabled = false;
        
        tileCtx.putImageData(imageData, 0, 0);
        
        ctx.drawImage(
          tileCanvas,
          tile.tileX * TILE_SIZE,
          tile.tileY * TILE_SIZE
        );
        
        const tileKey = `${tile.tileX}:${tile.tileY}`;
        setLoadedTiles(prev => new Set(prev).add(tileKey));
      } catch (error) {
        console.error('Error loading tile:', error);
      }
    });
    
    if (requestRedrawRef.current) {
      requestRedrawRef.current();
    }
  }, []);

  const requestTiles = useCallback((viewX, viewY, viewWidth, viewHeight) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    const startTileX = Math.floor(viewX / TILE_SIZE);
    const endTileX = Math.ceil((viewX + viewWidth) / TILE_SIZE);
    const startTileY = Math.floor(viewY / TILE_SIZE);
    const endTileY = Math.ceil((viewY + viewHeight) / TILE_SIZE);
    
    const neededTiles = [];
    
    for (let tileY = startTileY; tileY < endTileY; tileY++) {
      for (let tileX = startTileX; tileX < endTileX; tileX++) {
        const tileKey = `${tileX}:${tileY}`;
        if (!loadedTiles.has(tileKey) &&
            tileX >= 0 && tileX < Math.ceil(CANVAS_WIDTH / TILE_SIZE) &&
            tileY >= 0 && tileY < Math.ceil(CANVAS_HEIGHT / TILE_SIZE)) {
          neededTiles.push(`tile:${tileX}:${tileY}`);
        }
      }
    }
    
    if (neededTiles.length > 0) {
      ws.send(JSON.stringify({
        type: 'get_tiles',
        tileIds: neededTiles
      }));
    }
  }, [ws, loadedTiles]);

  const requestRedraw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    
    if (!canvas || !container || !offscreenCanvasRef.current) return;
    
    const ctx = canvas.getContext('2d');
    const rect = container.getBoundingClientRect();
    
    // Disable anti-aliasing for crisp pixels
    ctx.imageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;
    
    // Set canvas size to container size
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    
    // Clear canvas
    ctx.clearRect(0, 0, rect.width, rect.height);
    
    // Calculate visible area
    const viewX = -offset.x / scale;
    const viewY = -offset.y / scale;
    const viewWidth = rect.width / scale;
    const viewHeight = rect.height / scale;
    
    // Request tiles for visible area
    requestTiles(viewX, viewY, viewWidth, viewHeight);
    
    // Draw the offscreen canvas
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);
    
    // Only draw visible portion
    const sourceX = Math.max(0, viewX);
    const sourceY = Math.max(0, viewY);
    const sourceWidth = Math.min(CANVAS_WIDTH - sourceX, viewWidth);
    const sourceHeight = Math.min(CANVAS_HEIGHT - sourceY, viewHeight);
    
    if (sourceWidth > 0 && sourceHeight > 0) {
      ctx.drawImage(
        offscreenCanvasRef.current,
        sourceX, sourceY, sourceWidth, sourceHeight,
        sourceX, sourceY, sourceWidth, sourceHeight
      );
    }
    
    ctx.restore();
    
    // Draw grid at high zoom levels
    if (scale >= 4) {
      drawGrid(ctx, rect.width, rect.height);
    }

    // Draw image preview in image mode
    if (imageMode && pendingImage) {
      drawImagePreview(ctx, rect.width, rect.height);
    }
  }, [scale, offset, requestTiles, imageMode, pendingImage]);

  // Update the ref whenever requestRedraw changes
  useEffect(() => {
    requestRedrawRef.current = requestRedraw;
  }, [requestRedraw]);

  const drawGrid = useCallback((ctx, width, height) => {
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);
    
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
    ctx.lineWidth = 0.5 / scale;
    
    const viewX = -offset.x / scale;
    const viewY = -offset.y / scale;
    const viewWidth = width / scale;
    const viewHeight = height / scale;
    
    const startX = Math.floor(viewX);
    const endX = Math.ceil(viewX + viewWidth);
    const startY = Math.floor(viewY);
    const endY = Math.ceil(viewY + viewHeight);
    
    ctx.beginPath();
    for (let x = startX; x <= endX; x++) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y++) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();
    
    ctx.restore();
  }, [offset, scale]);

  const drawImagePreview = useCallback((ctx, width, height) => {
    if (!pendingImage) return;
    
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);
    
    const previewX = mousePos.x;
    const previewY = mousePos.y;
    
    // Draw semi-transparent overlay for image preview
    ctx.fillStyle = 'rgba(255, 255, 0, 0.3)';
    ctx.strokeStyle = 'rgba(255, 255, 0, 0.8)';
    ctx.lineWidth = 1 / scale;
    
    // Draw rectangle showing where image will be placed
    ctx.fillRect(previewX, previewY, pendingImage.imageSize.width, pendingImage.imageSize.height);
    ctx.strokeRect(previewX, previewY, pendingImage.imageSize.width, pendingImage.imageSize.height);
    
    ctx.restore();
  }, [offset, scale, mousePos, pendingImage]);

  // Resize handler
  useEffect(() => {
    const handleResize = () => requestRedraw();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [requestRedraw]);

  // Initial draw
  useEffect(() => {
    requestRedraw();
  }, [requestRedraw]);

  // Handle wheel events with proper passive: false
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const wheelHandler = (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent page zoom
      
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      
      setScale(prevScale => {
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prevScale * zoomFactor));
        
        if (newScale !== prevScale) {
          const scaleDiff = newScale - prevScale;
          setOffset(prevOffset => ({
            x: prevOffset.x - (mouseX - prevOffset.x) * (scaleDiff / prevScale),
            y: prevOffset.y - (mouseY - prevOffset.y) * (scaleDiff / prevScale)
          }));
        }
        
        return newScale;
      });
    };

    // Add event listener with passive: false to allow preventDefault
    container.addEventListener('wheel', wheelHandler, { passive: false });

    return () => {
      container.removeEventListener('wheel', wheelHandler);
    };
  }, []); // Empty dependency array - event handler is self-contained

  // Mouse handlers
  const handleMouseDown = useCallback((e) => {
    if (rateLimited) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setIsDragging(true);
    setDragStart({ x: x - offset.x, y: y - offset.y });
  }, [offset, rateLimited]);

  const handleMouseMove = useCallback((e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Update mouse position for display
    const canvasX = Math.floor((-offset.x + x) / scale);
    const canvasY = Math.floor((-offset.y + y) / scale);
    setMousePos({ x: canvasX, y: canvasY });
    
    if (isDragging && !rateLimited) {
      setOffset({
        x: x - dragStart.x,
        y: y - dragStart.y
      });
    }
  }, [isDragging, dragStart, offset, scale, rateLimited]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleClick = useCallback((e) => {
    if (isDragging || rateLimited) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const canvasX = Math.floor((-offset.x + x) / scale);
    const canvasY = Math.floor((-offset.y + y) / scale);
    
    if (canvasX >= 0 && canvasX < CANVAS_WIDTH && canvasY >= 0 && canvasY < CANVAS_HEIGHT) {
      if (imageMode && onImagePlace) {
        onImagePlace(canvasX, canvasY);
      } else {
        onPixelPlace(canvasX, canvasY, selectedColor);
      }
    }
  }, [isDragging, offset, scale, selectedColor, onPixelPlace, rateLimited, imageMode, onImagePlace]);


  return (
    <div 
      ref={containerRef}
      className={`canvas-container ${rateLimited ? 'rate-limited' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleClick}
    >
      <canvas ref={canvasRef} className="main-canvas" />
      
      <div className="canvas-overlay">
        <div>Position: ({mousePos.x}, {mousePos.y})</div>
        <div>Zoom: {(scale * 100).toFixed(0)}%</div>
        <div>Tiles loaded: {loadedTiles.size}</div>
      </div>
    </div>
  );
}

export default Canvas;
