from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))
# shadcn-ish indigo -> violet
c1, c2, c3 = (109,94,252), (139,123,255), (192,114,255)

# diagonal gradient
grad = Image.new("RGBA", (S, S))
gp = grad.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2*S)
        col = lerp(c1, c3, t) if t < 1 else c3
        gp[x, y] = col + (255,)

# rounded mask
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S-1, S-1], radius=int(S*0.235), fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
# Lucide "audio-lines": vertical bars (x, top, bottom) in 0..24 viewBox
bars = [(2,10,13),(6,6,17),(10,3,21),(14,8,15),(18,5,18),(22,10,13)]
scale = 20.0                 # 24*20 = 480px glyph
ox = S/2 - 12*scale          # center the 0..24 box
oy = S/2 - 12*scale
w = 2.0*scale                # strokeWidth 2
for (x, t, b) in bars:
    px = ox + x*scale
    y0 = oy + t*scale
    y1 = oy + b*scale
    d.rounded_rectangle([px-w/2, y0-w/2, px+w/2, y1+w/2], radius=w/2, fill=(255,255,255,255))

img.save("assets/icon-source.png")
print("wrote assets/icon-source.png", img.size)
