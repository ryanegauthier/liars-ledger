#!/usr/bin/env python3
# Run this once to generate placeholder icons
# pip install Pillow --break-system-packages

from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs("icons", exist_ok=True)

for size in [16, 48, 128]:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Background rounded rect (approximate with circle)
    draw.rounded_rectangle([0, 0, size-1, size-1], radius=size//5, fill="#c8a96e")
    # Checkmark
    font_size = int(size * 0.6)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
    except:
        font = ImageFont.load_default()
    draw.text((size//2, size//2), "✓", fill="#0f1117", font=font, anchor="mm")
    img.save(f"icons/icon{size}.png")
    print(f"Created icons/icon{size}.png")

print("Done.")
