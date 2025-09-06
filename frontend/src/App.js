import React, { useEffect, useRef, useState } from 'react';
import Canvas from './components/Canvas';
import ColorPalette from './components/ColorPalette';
import ConnectionStatus from './components/ConnectionStatus';
import ImageUpload from './components/ImageUpload';
import './App.css';

const WS_URL = process.env.REACT_APP_WS_URL || 'ws://localhost:9001';
console.log(process.env.REACT_APP_WS_URL);

function App() {
  const [ws, setWs] = useState(null);
  const [connected, setConnected] = useState(false);
  const [selectedColor, setSelectedColor] = useState('#ff0000');
  const [rateLimited, setRateLimited] = useState(false);
  const [showImageUpload, setShowImageUpload] = useState(false);
  const [pendingImage, setPendingImage] = useState(null);
  const [imageMode, setImageMode] = useState(false);
  const [imageDrawing, setImageDrawing] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (ws) {
        ws.close();
      }
    };
  }, []);

  const connectWebSocket = () => {
    try {
      const websocket = new WebSocket(WS_URL);
      
      websocket.onopen = () => {
        console.log('Connected to server');
        setConnected(true);
        setWs(websocket);
      };

      websocket.onclose = () => {
        console.log('Disconnected from server');
        setConnected(false);
        setWs(null);
        
        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('Attempting to reconnect...');
          connectWebSocket();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      };
    } catch (error) {
      console.error('Error connecting to WebSocket:', error);
      reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
    }
  };

  const handleMessage = (data) => {
    switch (data.type) {
      case 'pixel_update':
        // Canvas component will handle this through the ws prop
        break;
      case 'error':
        if (data.message === 'Rate limit exceeded') {
          setRateLimited(true);
          setTimeout(() => setRateLimited(false), 2000);
        }
        console.error('Server error:', data.message);
        
        // Clear image drawing status on error
        if (data.message.includes('image') || data.message.includes('Image')) {
          setImageDrawing(null);
        }
        break;
      case 'pixel_set':
        console.log('Pixel set confirmed:', data);
        break;
      case 'image_drawing_started':
        setImageDrawing({
          status: 'drawing',
          totalPixels: data.totalPixels,
          pixelsPlaced: 0,
          progress: 0,
          estimatedSeconds: data.estimatedSeconds
        });
        break;
      case 'image_drawing_progress':
        setImageDrawing(prev => prev ? {
          ...prev,
          pixelsPlaced: data.pixelsPlaced,
          progress: data.progress
        } : null);
        break;
      case 'image_drawing_complete':
        setImageDrawing(prev => prev ? {
          ...prev,
          status: 'complete',
          pixelsPlaced: data.pixelsPlaced,
          progress: 100
        } : null);
        // Clear after 3 seconds
        setTimeout(() => setImageDrawing(null), 3000);
        break;
      case 'image_chunk_received':
        console.log(`Chunk progress: ${data.chunksReceived}/${data.totalChunks} received`);
        break;
      case 'pong':
        // Keep-alive response
        break;
      default:
        console.log('Unknown message type:', data.type);
    }
  };

  const sendPixel = (x, y, color) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'set_pixel',
        x,
        y,
        color
      }));
    }
  };

  const handleImageProcessed = (pixels, imageSize) => {
    setPendingImage({ pixels, imageSize });
    setImageMode(true);
    setShowImageUpload(false);
  };

  const handleImagePlacement = (startX, startY) => {
    if (!pendingImage || !ws || ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot place image:', { pendingImage: !!pendingImage, ws: !!ws, readyState: ws?.readyState });
      return;
    }

    const { pixels } = pendingImage;
    
    console.log('Placing image:', { startX, startY, pixelCount: pixels.length });
    
    try {
      // Compress pixel data format: [x, y, color] arrays instead of objects
      const compressedPixels = pixels.map(p => [p.x, p.y, p.color]);
      
      // For large images, send in chunks to avoid WebSocket payload limits
      const chunkSize = 10000; // Pixels per chunk
      const totalChunks = Math.ceil(compressedPixels.length / chunkSize);
      const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      console.log(`Sending image in ${totalChunks} chunks of ${chunkSize} pixels each`);
      
      for (let i = 0; i < totalChunks; i++) {
        const startIdx = i * chunkSize;
        const endIdx = Math.min(startIdx + chunkSize, compressedPixels.length);
        const chunk = compressedPixels.slice(startIdx, endIdx);
        
        const message = {
          type: 'place_image_chunk',
          imageId,
          chunkIndex: i,
          totalChunks,
          startX,
          startY,
          pixels: chunk
        };
        
        // Add small delay between chunks to avoid overwhelming the WebSocket
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            console.log(`Sent chunk ${i + 1}/${totalChunks}`);
          }
        }, i * 50); // 50ms delay between chunks
      }
      
      console.log('All chunks sent to server');
    } catch (error) {
      console.error('Error sending image data:', error);
      return;
    }

    // Exit image mode
    setImageMode(false);
    setPendingImage(null);
  };

  // Send periodic ping to keep connection alive
  useEffect(() => {
    if (ws && connected) {
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);

      return () => clearInterval(pingInterval);
    }
  }, [ws, connected]);

  return (
    <div className="app">
      {/* Top Header */}
      <div className="app-header">
        <div className="header-left">
          <button 
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            {sidebarOpen ? '←' : '→'}
          </button>
          <h1>Place</h1>
        </div>
        <ConnectionStatus connected={connected} />
      </div>

      <div className="app-layout">
        {/* Collapsible Sidebar */}
        <div className={`sidebar ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
          <div className="sidebar-content">
            <div className="sidebar-section">
              <h3>Colors</h3>
              <ColorPalette 
                selectedColor={selectedColor}
                onColorSelect={setSelectedColor}
              />
            </div>
            
            <div className="sidebar-section">
              <h3>Tools</h3>
              <button 
                className="tool-button image-upload-button"
                onClick={() => setShowImageUpload(true)}
                disabled={!connected || rateLimited}
              >
                📷 Upload Image
              </button>
              
              {imageMode && (
                <div className="image-mode-controls">
                  <div className="image-mode-info">
                    Image mode: Click to place {pendingImage?.pixels.length} pixels
                  </div>
                  <button 
                    className="tool-button cancel-image-button"
                    onClick={() => {
                      setImageMode(false);
                      setPendingImage(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Status Messages */}
            {rateLimited && (
              <div className="sidebar-section">
                <div className="rate-limit-warning">
                  Rate limited! Please wait before placing another pixel.
                </div>
              </div>
            )}
            
            {imageDrawing && (
              <div className="sidebar-section">
                <div className="image-drawing-status">
                  <div className="image-drawing-info">
                    {imageDrawing.status === 'drawing' ? '🎨 Drawing image...' : '✅ Image complete!'}
                    <div>{imageDrawing.pixelsPlaced}/{imageDrawing.totalPixels} pixels ({imageDrawing.progress}%)</div>
                  </div>
                  {imageDrawing.status === 'drawing' && (
                    <div className="progress-bar">
                      <div 
                        className="progress-fill" 
                        style={{ width: `${imageDrawing.progress}%` }}
                      ></div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Main Canvas Area */}
        <div className="main-content">
          <Canvas 
            ws={ws}
            selectedColor={selectedColor}
            onPixelPlace={sendPixel}
            rateLimited={rateLimited}
            imageMode={imageMode}
            pendingImage={pendingImage}
            onImagePlace={handleImagePlacement}
          />
        </div>
      </div>
      
      {showImageUpload && (
        <ImageUpload 
          onImageProcessed={handleImageProcessed}
          onCancel={() => setShowImageUpload(false)}
        />
      )}
    </div>
  );
}

export default App;
