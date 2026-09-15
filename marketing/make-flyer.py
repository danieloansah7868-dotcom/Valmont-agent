from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
ORANGE = (245, 140, 20)   # #f58c14
NAVY   = (14, 29, 61)     # #0e1d3d
DARK   = (11, 20, 40)     # #0b1428
GREY   = (185, 196, 221)  # #b9c4dd
WHITE  = (255, 255, 255)
CARDLN = (34, 48, 84)

img = Image.new("RGB", (W, H), DARK)
d = ImageDraw.Draw(img)

FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
f = lambda sz, b=True: ImageFont.truetype(FB if b else FR, sz)

def center(text, y, font, fill):
    w = d.textlength(text, font=font)
    d.text(((W - w) / 2, y), text, font=font, fill=fill)

def rrect(x, y, w, h, r, fill, outline=None, ow=0):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill,
                        outline=outline, width=ow)

# top & bottom brand bars
d.rectangle([0, 0, W, 14], fill=ORANGE)
d.rectangle([0, H - 14, W, H], fill=ORANGE)

center("ACCRA · GHANA", 52, f(26), GREY)

# brand lockup (text-mark, no invented logo)
center("VALMONT", 104, f(96), WHITE)
center("ELECTRICALS", 212, f(58), ORANGE)
center("Powering Homes. Energizing Life.", 296, f(30, False), GREY)

# headline
center("GENUINE ELECTRICALS", 372, f(66), WHITE)
center("AT HONEST PRICES", 454, f(66), ORANGE)

# price cards
cards = [
    ("RR 1.5mm Cable — 100m",      "GH\u00a2 420"),
    ("RR 2.5mm Cable — 100m",      "GH\u00a2 640"),
    ("Focus Double 13A Socket",    "GH\u00a2 38"),
    ("Crompton Ceiling Fans",      "from GH\u00a2 320"),
]
y = 560
for name, price in cards:
    rrect(70, y, 940, 92, 16, NAVY, CARDLN, 2)
    rrect(70, y, 12, 92, 6, ORANGE)          # orange accent edge
    d.text((108, y + 26), name, font=f(34), fill=WHITE)
    pw = d.textlength(price, font=f(38))
    d.text((70 + 940 - pw - 34, y + 24), price, font=f(38), fill=ORANGE)
    y += 108

# brands
center("GENUINE BRANDS WE STOCK", 1006, f(26), GREY)
center("FOCUS · CROMPTON · BAJAJ · HAVELLS", 1048, f(32), WHITE)
center("RR · NEXANS · BRISTOL · TROPICAL", 1094, f(32), WHITE)

# genuine chip
chip_t = "100% GENUINE PRODUCTS"
cw = d.textlength(chip_t, font=f(30)) + 76
rrect((W - cw) / 2, 1158, cw, 58, 29, DARK, ORANGE, 3)
center(chip_t, 1172, f(30), ORANGE)

# WhatsApp CTA button
rrect(70, 1258, 940, 168, 22, ORANGE)
center("ORDER ON WHATSAPP", 1282, f(40), DARK)
center("054 245 1578", 1340, f(74), WHITE)

center("valmontelectricals.com", 1468, f(36), WHITE)
center("Accra & Nationwide Delivery", 1522, f(30, False), GREY)
center("Full payment before dispatch — no credit", 1572, f(24, False), GREY)

img.save("/home/user/Valmont-agent/marketing/valmont-electricals-tiktok.png")
print("SAVED", img.size)
