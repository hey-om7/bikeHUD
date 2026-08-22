import os
from PIL import Image

def convert_to_rgb565_pro(input_path, output_path, target_width=None, target_height=None, swap_bytes=True, dither=True):
    """
    Converts an image to a 16-bit RGB565 C-array with dithering and endianness correction.
    """
    if not os.path.exists(input_path):
        print(f"Error: Could not find image at '{input_path}'")
        return

    print(f"Opening {input_path}...")
    # Open image and force conversion to standard RGB (strips alpha channel safely)[cite: 1]
    img = Image.open(input_path).convert('RGB')
    original_width, original_height = img.size
    print(f"Original image dimensions: {original_width}x{original_height}")

    # Resize image if target dimensions are provided[cite: 1]
    if target_width and target_height and (original_width != target_width or original_height != target_height):
        print(f"Resizing image to {target_width}x{target_height} using high-quality LANCZOS resampling...")
        # LANCZOS provides the best downsampling quality[cite: 1]
        img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
    
    width, height = img.size
    pixels = list(img.getdata())

    # --- FLOYD-STEINBERG DITHERING ---
    if dither:
        print("Applying Floyd-Steinberg dithering to eliminate color banding...")
        pixels = [list(p) for p in pixels] # Convert tuples to mutable lists
        for y in range(height):
            for x in range(width):
                idx = y * width + x
                old_r, old_g, old_b = pixels[idx]
                
                # Quantize to RGB565 color space
                new_r = (old_r & 0xF8) | (old_r >> 5)
                new_g = (old_g & 0xFC) | (old_g >> 6)
                new_b = (old_b & 0xF8) | (old_b >> 5)
                
                pixels[idx] = (new_r, new_g, new_b)
                
                # Calculate quantization error
                err_r = old_r - new_r
                err_g = old_g - new_g
                err_b = old_b - new_b
                
                # Distribute error to neighboring pixels
                def distribute(dx, dy, factor):
                    if 0 <= x + dx < width and 0 <= y + dy < height:
                        n_idx = (y + dy) * width + (x + dx)
                        nr = min(max(int(pixels[n_idx][0] + err_r * factor), 0), 255)
                        ng = min(max(int(pixels[n_idx][1] + err_g * factor), 0), 255)
                        nb = min(max(int(pixels[n_idx][2] + err_b * factor), 0), 255)
                        pixels[n_idx] = [nr, ng, nb]
                
                distribute(1, 0, 7/16)
                distribute(-1, 1, 3/16)
                distribute(0, 1, 5/16)
                distribute(1, 1, 1/16)

    print(f"Converting to 16-bit RGB565 format (Swap Bytes: {swap_bytes})...")
    
    with open(output_path, 'w') as f:
        # Write standard C header guards and includes[cite: 1, 2]
        f.write(f"// Automatically generated from {os.path.basename(input_path)}\n")
        f.write(f"// Dimensions: {width} x {height}\n")
        f.write("#ifndef DASHBOARD_BG_H\n")
        f.write("#define DASHBOARD_BG_H\n\n")
        f.write("#include <pgmspace.h>\n\n")
        
        # Declare the array in PROGMEM (Flash memory)[cite: 1, 2]
        f.write(f"const unsigned short dashboard_bg_bitmap[{width * height}] PROGMEM = {{\n")

        for y in range(height):
            row_data = []
            for x in range(width):
                idx = y * width + x
                r, g, b = pixels[idx]
                
                # Red: top 5 bits, Green: top 6 bits, Blue: top 5 bits[cite: 1]
                rgb565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
                
                # --- BYTE SWAP FOR ST7789 SPI ---
                if swap_bytes:
                    rgb565 = ((rgb565 & 0xFF) << 8) | (rgb565 >> 8)
                
                row_data.append(f"0x{rgb565:04X}")
                
            # Write a full row of pixels, followed by a newline for readability[cite: 1]
            f.write("    " + ", ".join(row_data) + ",\n")

        f.write("};\n\n")
        f.write("#endif // DASHBOARD_BG_H\n")

    print(f"Success! Array saved to '{output_path}'.")

if __name__ == "__main__":
    IMAGE_FILE = input("enter the full input file name:")
    OUTPUT_FILE = IMAGE_FILE.split(".")[0]+".h"
    SCREEN_WIDTH = 320 
    SCREEN_HEIGHT = 240 
    
    # Run with dithering and byte-swapping enabled
    convert_to_rgb565_pro(IMAGE_FILE, OUTPUT_FILE, SCREEN_WIDTH, SCREEN_HEIGHT, swap_bytes=False, dither=True)