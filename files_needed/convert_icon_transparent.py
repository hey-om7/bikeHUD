import os
from PIL import Image

def convert_to_rgb565_transparent(input_path, output_path, target_width=None, target_height=None, swap_bytes=False, dither=True, alpha_threshold=128):
    # alpha_threshold: pixels with alpha below this become fully transparent
    # (0x0000). This is REQUIRED because the display uses color-key transparency
    # (only exactly 0x0000 is treated as see-through). Pre-multiplying alpha would
    # turn soft/anti-aliased edges into dark-but-nonzero pixels, producing the
    # black rectangular halo around the icon.
    if not os.path.exists(input_path):
        print(f"Error: Could not find '{input_path}'")
        return

    print(f"Opening {input_path}...")
    # Convert to RGBA to preserve the transparency channel!
    img = Image.open(input_path).convert('RGBA')
    
    # Auto-crop the giant transparent boundary
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
        print(f"Cropped transparent padding. New size: {img.width}x{img.height}")
    
    if target_width and target_height and (img.width != target_width or img.height != target_height):
        img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
    
    width, height = img.size
    pixels = list(img.getdata())
    
    # Convert to mutable lists: [R, G, B, A]
    pixels = [list(p) for p in pixels]

    if dither:
        print("Applying dithering (protecting transparency)...")
        for y in range(height):
            for x in range(width):
                idx = y * width + x
                old_r, old_g, old_b, a = pixels[idx]
                
                # Skip dithering for pixels that will be treated as transparent
                if a < alpha_threshold:
                    continue
                    
                # Quantize
                new_r = (old_r & 0xF8) | (old_r >> 5)
                new_g = (old_g & 0xFC) | (old_g >> 6)
                new_b = (old_b & 0xF8) | (old_b >> 5)
                
                pixels[idx] = [new_r, new_g, new_b, a]
                
                err_r = old_r - new_r
                err_g = old_g - new_g
                err_b = old_b - new_b
                
                def distribute(dx, dy, factor):
                    if 0 <= x + dx < width and 0 <= y + dy < height:
                        n_idx = (y + dy) * width + (x + dx)
                        # ONLY distribute error into neighbors that will be kept
                        if pixels[n_idx][3] >= alpha_threshold:
                            nr = min(max(int(pixels[n_idx][0] + err_r * factor), 0), 255)
                            ng = min(max(int(pixels[n_idx][1] + err_g * factor), 0), 255)
                            nb = min(max(int(pixels[n_idx][2] + err_b * factor), 0), 255)
                            pixels[n_idx][0:3] = [nr, ng, nb]
                
                distribute(1, 0, 7/16)
                distribute(-1, 1, 3/16)
                distribute(0, 1, 5/16)
                distribute(1, 1, 1/16)

    print(f"Converting to 16-bit C-array (Swap Bytes: {swap_bytes})...")
    
    base_name = os.path.splitext(os.path.basename(input_path))[0]
    array_name = f"{base_name}_bitmap"
    guard_name = base_name.upper() + "_H"

    with open(output_path, 'w') as f:
        f.write(f"// Automatically generated from {os.path.basename(input_path)}\n")
        f.write(f"// Auto-cropped Dimensions: {width} x {height}\n")
        f.write(f"#ifndef {guard_name}\n")
        f.write(f"#define {guard_name}\n\n")
        f.write("#include <pgmspace.h>\n\n")
        f.write(f"#define {base_name.upper()}_WIDTH {width}\n")
        f.write(f"#define {base_name.upper()}_HEIGHT {height}\n\n")
        f.write(f"const unsigned short {array_name}[{width * height}] PROGMEM = {{\n")

        for y in range(height):
            row_data = []
            for x in range(width):
                idx = y * width + x
                r, g, b, a = pixels[idx]
                
                if a < alpha_threshold:
                    rgb565 = 0x0000  # Transparent color-key: display shows background here
                else:
                    # Keep the pixel's TRUE color (no alpha pre-multiply, so edges
                    # stay crisp instead of fading to black).
                    rgb565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
                    # Protect opaque black from being mistaken for transparent
                    if rgb565 == 0x0000:
                        rgb565 = 0x0001 
                
                if swap_bytes:
                    rgb565 = ((rgb565 & 0xFF) << 8) | (rgb565 >> 8)
                
                row_data.append(f"0x{rgb565:04X}")
                
            f.write("    " + ", ".join(row_data) + ",\n")

        f.write("};\n\n")
        f.write(f"#endif // {guard_name}\n")

    print(f"Success! Array saved to '{output_path}'.")

if __name__ == "__main__":
    IMAGE_FILE = input("Enter the full input file name: ")
    OUTPUT_FILE = IMAGE_FILE.split(".")[0] + "_2.h"
    # No byte swap, dithering on, alpha cutoff at 128 (clean color-key transparency)
    convert_to_rgb565_transparent(IMAGE_FILE, OUTPUT_FILE, swap_bytes=False, dither=True, alpha_threshold=128)