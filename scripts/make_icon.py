from PIL import Image, ImageDraw, ImageFilter

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# near-black base
base = Image.new("RGBA", (S, S), (11, 11, 13, 255))
# glyph lighting: soft radial light from upper-center
light = Image.new("L", (S, S), 0)
ld = ImageDraw.Draw(light)
ld.ellipse([S*0.12, -S*0.28, S*0.88, S*0.62], fill=70)
light = light.filter(ImageFilter.GaussianBlur(120))
glow = Image.new("RGBA", (S, S), (255, 255, 255, 255))
glow.putalpha(light)
base = Image.alpha_composite(base, glow)

# rounded mask
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S-1, S-1], radius=int(S*0.235), fill=255)
img.paste(base, (0, 0), mask)

d = ImageDraw.Draw(img)
# Lucide audio-lines bars, white
bars = [(2,10,13),(6,6,17),(10,3,21),(14,8,15),(18,5,18),(22,10,13)]
scale = 20.0
ox = S/2 - 12*scale; oy = S/2 - 12*scale; w = 2.0*scale
for (x, t, b) in bars:
    px = ox + x*scale; y0 = oy + t*scale; y1 = oy + b*scale
    d.rounded_rectangle([px-w/2, y0-w/2, px+w/2, y1+w/2], radius=w/2, fill=(250,250,250,255))

# subtle top rim light
rim = Image.new("RGBA", (S, S), (0,0,0,0))
ImageDraw.Draw(rim).rounded_rectangle([2,2,S-3,S-3], radius=int(S*0.233), outline=(255,255,255,40), width=3)
img = Image.alpha_composite(img, Image.composite(rim, Image.new("RGBA",(S,S),(0,0,0,0)), mask))

img.save("assets/icon-source.png")
print("wrote monochrome icon", img.size)
