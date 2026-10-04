from PIL import Image, ImageDraw
import math

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded-square background with aurora diagonal gradient
def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))
c1, c2, c3 = (90,209,255), (139,123,255), (200,107,255)
bg = Image.new("RGBA", (S, S), (0,0,0,0))
bd = ImageDraw.Draw(bg)
for y in range(S):
    for_t = y / S
    # diagonal-ish: blend by y then shift by x handled per-row approx
    col = lerp(c1, c3, for_t) if for_t < 1 else c3
    bd.line([(0,y),(S,y)], fill=col+ (255,))
# horizontal blend overlay for diagonal feel
ov = Image.new("RGBA", (S, S), (0,0,0,0))
od = ImageDraw.Draw(ov)
for x in range(S):
    t = x / S
    col = lerp(c1, c2, t)
    od.line([(x,0),(x,S)], fill=col + (90,))
bg = Image.alpha_composite(bg, ov)

# rounded mask
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
r = int(S*0.235)
md.rounded_rectangle([0,0,S,S], radius=r, fill=255)
img.paste(bg, (0,0), mask)

d = ImageDraw.Draw(img)
# central orb (ring) — the "voice" mark
cx, cy = S//2, S//2
R = int(S*0.26)
d.ellipse([cx-R, cy-R, cx+R, cy+R], fill=(13,14,18,235))
ring = int(S*0.045)
d.ellipse([cx-R, cy-R, cx+R, cy+R], outline=(255,255,255,235), width=ring)
# small inner dot
r2 = int(S*0.075)
d.ellipse([cx-r2, cy-r2, cx+r2, cy+r2], fill=(255,255,255,245))

img.save("assets/icon-source.png")
print("wrote assets/icon-source.png", img.size)
