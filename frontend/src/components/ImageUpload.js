import React, { useState, useRef } from 'react';

function ImageUpload({ onImageProcessed, onCancel }) {
  const [previewImage, setPreviewImage] = useState(null);
  const [processedPixels, setProcessedPixels] = useState(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const fileInputRef = useRef(null);

  const processImage = (file) => {
    if (!file || !file.type.startsWith('image/')) {
      alert('Please select a valid image file');
      return;
    }

    const img = new Image();
    // Create a temporary canvas since the ref canvas might not exist yet
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    img.onload = () => {
      // Calculate new dimensions (max 200x200)
      let { width, height } = img;
      const maxSize = 200;
      
      console.log('Original image size:', { width, height });
      
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height);
        width = Math.floor(width * ratio);
        height = Math.floor(height * ratio);
        console.log('Resized to:', { width, height, ratio });
      } else {
        console.log('Image within size limits, no resize needed');
      }

      // Ensure minimum size of 1x1
      width = Math.max(1, width);
      height = Math.max(1, height);

      // Set canvas size and disable anti-aliasing
      canvas.width = width;
      canvas.height = height;
      ctx.imageSmoothingEnabled = false;
      ctx.webkitImageSmoothingEnabled = false;
      ctx.mozImageSmoothingEnabled = false;
      ctx.msImageSmoothingEnabled = false;

      // Draw image to canvas
      ctx.drawImage(img, 0, 0, width, height);

      // Get pixel data
      const imageData = ctx.getImageData(0, 0, width, height);
      const pixels = [];

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 4;
          const r = imageData.data[index];
          const g = imageData.data[index + 1];
          const b = imageData.data[index + 2];
          const a = imageData.data[index + 3];

          // Skip transparent pixels
          if (a < 128) continue;

          // Convert to hex color
          const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          
          pixels.push({ x, y, color });
        }
      }

      console.log('Processed pixels:', pixels.length);
      
      if (pixels.length === 0) {
        alert('No visible pixels found in image. Make sure the image is not fully transparent.');
        return;
      }

      if (pixels.length > 40000) { // 200x200 max
        alert('Image too complex. Try a simpler image with fewer colors.');
        return;
      }

      setProcessedPixels(pixels);
      setImageSize({ width, height });
      setPreviewImage(canvas.toDataURL());
    };

    img.onerror = (error) => {
      console.error('Error loading image:', error);
      alert('Failed to load image. Please try a different file.');
    };

    img.src = URL.createObjectURL(file);
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      processImage(file);
    }
  };

  const handlePlaceImage = () => {
    if (processedPixels && onImageProcessed) {
      onImageProcessed(processedPixels, imageSize);
    }
  };

  const handleReset = () => {
    setPreviewImage(null);
    setProcessedPixels(null);
    setImageSize({ width: 0, height: 0 });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="image-upload-modal">
      <div className="image-upload-content">
        <div className="image-upload-header">
          <h3>Upload Image</h3>
          <button className="close-button" onClick={onCancel}>×</button>
        </div>

        <div className="image-upload-body">
          {!previewImage ? (
            <div className="upload-area">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={handleFileChange}
                className="file-input"
                id="image-upload-input"
              />
              <label htmlFor="image-upload-input" className="upload-label">
                <div className="upload-icon">📁</div>
                <div>Click to select an image</div>
                <div className="upload-note">Max size: 200x200 pixels</div>
              </label>
            </div>
          ) : (
            <div className="preview-area">
              <div className="preview-image-container">
                <img src={previewImage} alt="Preview" className="preview-image" />
              </div>
              
              <div className="image-info">
                <p>Size: {imageSize.width} × {imageSize.height} pixels</p>
                <p>Pixels to place: {processedPixels?.length || 0}</p>
              </div>

              <div className="preview-instructions">
                <p>Click on the canvas to choose where to place the top-left corner of your image.</p>
              </div>
            </div>
          )}
        </div>

        <div className="image-upload-footer">
          {previewImage ? (
            <>
              <button className="button-secondary" onClick={handleReset}>
                Choose Different Image
              </button>
              <button className="button-primary" onClick={handlePlaceImage}>
                Place Image
              </button>
            </>
          ) : (
            <button className="button-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ImageUpload;