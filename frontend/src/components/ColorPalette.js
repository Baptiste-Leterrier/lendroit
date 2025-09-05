import React, { useState } from 'react';

const PRESET_COLORS = [
  '#ff0000', '#00ff00', '#0000ff', '#ffff00',
  '#ff00ff', '#00ffff', '#ffffff', '#000000',
  '#ff8000', '#8000ff', '#0080ff', '#80ff00',
  '#ff0080', '#00ff80', '#808080', '#404040',
  '#800000', '#008000', '#000080', '#808000',
  '#800080', '#008080', '#c0c0c0', '#404040',
  '#ff6666', '#66ff66', '#6666ff', '#ffff66',
  '#ff66ff', '#66ffff', '#666666', '#999999'
];

function ColorPalette({ selectedColor, onColorSelect }) {
  const [customColor, setCustomColor] = useState('#000000');
  const [showColorPicker, setShowColorPicker] = useState(false);

  const handleCustomColorChange = (e) => {
    const color = e.target.value;
    setCustomColor(color);
    onColorSelect(color);
  };

  return (
    <div className="color-palette">
      <div className="preset-colors">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            className={`color-button ${selectedColor === color ? 'selected' : ''}`}
            style={{ backgroundColor: color }}
            onClick={() => onColorSelect(color)}
            title={color}
          />
        ))}
      </div>
      
      <div className="color-controls">
        <button
          className="custom-color-button"
          onClick={() => setShowColorPicker(!showColorPicker)}
        >
          Custom Color
        </button>
        
        {showColorPicker && (
          <div className="color-picker-container">
            <input
              type="color"
              value={customColor}
              onChange={handleCustomColorChange}
              className="color-picker"
            />
            <input
              type="text"
              value={customColor}
              onChange={(e) => {
                if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) {
                  setCustomColor(e.target.value);
                  if (e.target.value.length === 7) {
                    onColorSelect(e.target.value);
                  }
                }
              }}
              className="color-input"
              placeholder="#000000"
            />
          </div>
        )}
        
        <div className="transparency-note">
          Note: Transparency not supported in canvas pixels
        </div>
      </div>
      
      <div className="selected-color-display">
        <div>Selected: 
          <span 
            className="selected-color-swatch"
            style={{ backgroundColor: selectedColor }}
          ></span>
          {selectedColor}
        </div>
      </div>
    </div>
  );
}

export default ColorPalette;