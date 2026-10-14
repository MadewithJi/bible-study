"""Bible Lantern mark in the manner of a Doré engraving: the lantern drawn in fine hatched lines, a cross at its
heart, and the light breaking through the glass as radiating rays. Writes SVGs (vector, any size) and PNG previews.

  python3 .design/logo/engrave.py            -> .design/logo/out/mark-{dark,paper}.svg, lockup-*.svg, *.png

Geometry is in the app icon's 24-unit space (app/index.html .wordmark .mark), so the new mark lines up with the old one."""
import math, os, random, subprocess, sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# ---- the lantern in mark units -------------------------------------------------------------------------------
CX, CY = 12.0, 13.1           # the cross (and the light) sits here, in the middle of the glass
BODY = (6.9, 7.4, 10.2, 11.1, 2.6)   # x y w h rx  (the glass case)
CAP = [(8.3, 7.4), (9.5, 4.6), (14.5, 4.6), (15.7, 7.4)]   # the hood, a trapezoid
RING = (12.0, 4.0, 1.8)       # ring handle: cx cy r (top half drawn)
# the foot: a collar under the case, a tapered column, and a plinth in two steps (x y w h each)
COLLAR = (10.5, 18.45, 3.0, 0.5)
STEM = ((11.35, 18.95), (12.65, 18.95), (13.1, 20.45), (10.9, 20.45))   # the column, wider at the base
TIER1 = (8.9, 20.4, 6.2, 0.55)
TIER2 = (7.4, 20.9, 9.2, 0.85)
CROSS = (0.62, 10.35, 16.3, 9.75, 14.25, 11.95)   # bar width, vertical y0 y1, horizontal x0 x1, horizontal y


def wedge(a, r0, r1, w):
    ca, sa = math.cos(a), math.sin(a)
    px, py = -sa * w / 2, ca * w / 2
    x0, y0 = CX + ca * r0, CY + sa * r0
    return (x0 + px, y0 + py, x0 - px, y0 - py, CX + ca * r1, CY + sa * r1)


def rays(seed=7):
    """The glory, in three layers as an engraver cuts it: a few broad beams, long thin rays between them, and a
    dense fringe of short hairs close to the light. All start behind the cross, so there is no dark core."""
    rnd = random.Random(seed)
    beams, longs, hairs = [], [], []
    for i in range(14):
        a = math.radians(i * 360 / 14 + 9 + rnd.uniform(-5, 5))
        beams.append(wedge(a, 0.3, rnd.uniform(7.5, 11.5), rnd.uniform(0.55, 0.95)))
    for i in range(44):
        a = math.radians(i * 360 / 44 + rnd.uniform(-2.5, 2.5))
        longs.append(wedge(a, 0.3, rnd.uniform(4.5, 9.5), rnd.uniform(0.09, 0.16)))
    for i in range(150):
        a = math.radians(i * 360 / 150 + rnd.uniform(-1, 1))
        hairs.append(wedge(a, 0.3, rnd.uniform(1.3, 3.4), rnd.uniform(0.035, 0.06)))
    return beams, longs, hairs


def hatch_lines(x0, y0, x1, y1, angle_deg, spacing, phase=0.0):
    """Parallel lines at an angle covering the box; the caller clips them to a shape."""
    a = math.radians(angle_deg)
    dx, dy = math.cos(a), math.sin(a)           # along the line
    nx, ny = -dy, dx                            # across the lines
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = math.hypot(x1 - x0, y1 - y0) / 2 + spacing
    lines = []
    k = -half
    while k <= half:
        mx, my = cx + nx * (k + phase), cy + ny * (k + phase)
        lines.append((mx - dx * half, my - dy * half, mx + dx * half, my + dy * half))
        k += spacing
    return lines


def svg_mark(theme="dark", size=1024, glow=True, transparent=False):
    ink = "#f5f0e6" if theme == "dark" else "#141210"      # the line colour
    bg = "#07070a" if theme == "dark" else "#f4efe4"        # the ground
    warm = "#ffb860" if theme == "dark" else "#141210"      # the light itself
    s = size / 24.0
    o = []
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">')
    o.append('<defs>')
    o.append(f'<radialGradient id="glow" cx="{CX*s}" cy="{CY*s}" r="{5.2*s}" gradientUnits="userSpaceOnUse">'
             f'<stop offset="0" stop-color="{warm}" stop-opacity="{.55 if theme=="dark" else .0}"/><stop offset=".35" stop-color="{warm}" stop-opacity="{.22 if theme=="dark" else 0}"/><stop offset="1" stop-color="{warm}" stop-opacity="0"/></radialGradient>')
    o.append(f'<radialGradient id="rayfade" cx="{CX*s}" cy="{CY*s}" r="{11.5*s}" gradientUnits="userSpaceOnUse">'
             f'<stop offset="0" stop-color="{ink}" stop-opacity="1"/><stop offset=".5" stop-color="{ink}" stop-opacity=".8"/><stop offset="1" stop-color="{ink}" stop-opacity=".12"/></radialGradient>')
    o.append(f'<radialGradient id="beamfade" cx="{CX*s}" cy="{CY*s}" r="{11.5*s}" gradientUnits="userSpaceOnUse">'
             f'<stop offset="0" stop-color="{warm if theme=="dark" else ink}" stop-opacity="{.5 if theme=="dark" else .18}"/><stop offset=".45" stop-color="{warm if theme=="dark" else ink}" stop-opacity="{.22 if theme=="dark" else .1}"/><stop offset="1" stop-color="{warm if theme=="dark" else ink}" stop-opacity="0"/></radialGradient>')
    # far from the light the glass carries the engraver's hatching; near it the lines give way to white
    o.append(f'<radialGradient id="farg" cx="{CX*s}" cy="{CY*s}" r="{6.2*s}" gradientUnits="userSpaceOnUse">'
             f'<stop offset=".3" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>')
    o.append(f'<mask id="far" maskUnits="userSpaceOnUse" x="0" y="0" width="{size}" height="{size}"><rect width="{size}" height="{size}" fill="url(#farg)"/></mask>')
    o.append(f'<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{0.28 * s:.1f}"/></filter>')
    bx, by, bw, bh, br = BODY
    o.append(f'<clipPath id="glass"><rect x="{(bx+.42)*s}" y="{(by+.42)*s}" width="{(bw-.84)*s}" height="{(bh-.84)*s}" rx="{(br-.4)*s}"/></clipPath>')
    cap_pts = " ".join(f"{x*s},{y*s}" for x, y in CAP)
    o.append(f'<clipPath id="capc"><polygon points="{cap_pts}"/></clipPath>')
    rect = lambda r, rx: f'<rect x="{r[0]*s}" y="{r[1]*s}" width="{r[2]*s}" height="{r[3]*s}" rx="{rx*s}"/>'
    stem_pts = " ".join(f"{x*s},{y*s}" for x, y in STEM)
    o.append(f'<clipPath id="tier1c">{rect(TIER1, .1)}</clipPath><clipPath id="tier2c">{rect(TIER2, .14)}</clipPath>')
    o.append(f'<clipPath id="stemc"><polygon points="{stem_pts}"/></clipPath><clipPath id="collarc">{rect(COLLAR, .1)}</clipPath>')
    o.append('</defs>')
    if not transparent: o.append(f'<rect width="{size}" height="{size}" fill="{bg}"/>')
    # the glory: a soft glow, then the rays (they pass through the glass and on past the frame)
    if glow: o.append(f'<circle cx="{CX*s}" cy="{CY*s}" r="{5.2*s}" fill="url(#glow)"/>')
    # the frame's thickness: a second edge a hair down and right, as the engraver shows the metal's depth
    o.append(f'<rect x="{(bx+.16)*s}" y="{(by+.16)*s}" width="{bw*s}" height="{bh*s}" rx="{br*s}" fill="none" stroke="{ink}" stroke-width="{.06*s}" opacity=".6"/>')
    beams, longs, hairs = rays()
    poly = lambda w: f'<polygon points="{w[0]*s:.1f},{w[1]*s:.1f} {w[2]*s:.1f},{w[3]*s:.1f} {w[4]*s:.1f},{w[5]*s:.1f}"/>'
    o.append('<g fill="url(#beamfade)">' + "".join(poly(w) for w in beams) + '</g>')
    o.append('<g fill="url(#rayfade)">' + "".join(poly(w) for w in longs) + "".join(poly(w) for w in hairs) + '</g>')
    # the glass, hatched where the light does not reach (corners and edges of the panes)
    o.append(f'<g clip-path="url(#glass)" mask="url(#far)" stroke="{ink}" stroke-width="{.04*s}" opacity="{.28 if theme=="dark" else .4}">')
    for (x0, y0, x1, y1) in hatch_lines(bx, by, bx + bw, by + bh, 52, 0.24 if theme == "dark" else 0.3):
        o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}"/>')
    for (x0, y0, x1, y1) in hatch_lines(bx, by, bx + bw, by + bh, -38, 0.36 if theme == "dark" else 0.5):
        o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}" opacity=".7"/>')
    o.append('</g>')
    # engraver's halos: broken concentric arcs around the light
    for r, dash in ((2.55, "9 7"), (3.25, "6 10"), (3.95, "4 14")):
        o.append(f'<circle cx="{CX*s}" cy="{CY*s}" r="{r*s}" fill="none" stroke="{ink}" stroke-width="{.04*s}" stroke-dasharray="{dash}" opacity=".45"/>')
    # metal occludes light: the hood and the foot are solid, then hatched
    o.append(f'<polygon points="{cap_pts}" fill="{bg}"/>')
    o.append(f'<g fill="{bg}">{rect(TIER1, .1)}{rect(TIER2, .14)}<polygon points="{stem_pts}"/>{rect(COLLAR, .1)}</g>')
    # hood hatching: one direction all over, cross-hatched on the shadow side
    o.append(f'<g clip-path="url(#capc)" stroke="{ink}" stroke-width="{.055*s}" stroke-linecap="round">')
    for (x0, y0, x1, y1) in hatch_lines(8, 4.4, 16, 7.6, 38, 0.21):
        o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}"/>')
    for (x0, y0, x1, y1) in hatch_lines(12.6, 4.4, 16, 7.6, -48, 0.27):
        if x0 + x1 > 25: o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}" opacity=".85"/>')
    o.append('</g>')
    o.append(f'<polygon points="{cap_pts}" fill="none" stroke="{ink}" stroke-width="{.16*s}" stroke-linejoin="round"/>')
    # ring handle: a thick ring with a thin inner line
    rx_, ry_, rr = RING
    o.append(f'<path d="M{(rx_-rr)*s},{ry_*s+.4*s} A{rr*s},{rr*s} 0 0 1 {(rx_+rr)*s},{ry_*s+.4*s}" fill="none" stroke="{ink}" stroke-width="{.3*s}" stroke-linecap="round"/>')
    o.append(f'<path d="M{(rx_-rr+.42)*s},{ry_*s+.4*s} A{(rr-.42)*s},{(rr-.42)*s} 0 0 1 {(rx_+rr-.42)*s},{ry_*s+.4*s}" fill="none" stroke="{bg}" stroke-width="{.07*s}" stroke-linecap="round"/>')
    # the glass case: an outer frame, a thin inner line, and engraved ticks along the frame
    o.append(f'<rect x="{bx*s}" y="{by*s}" width="{bw*s}" height="{bh*s}" rx="{br*s}" fill="none" stroke="{ink}" stroke-width="{.17*s}"/>')
    o.append(f'<rect x="{(bx+.42)*s}" y="{(by+.42)*s}" width="{(bw-.84)*s}" height="{(bh-.84)*s}" rx="{(br-.4)*s}" fill="none" stroke="{ink}" stroke-width="{.055*s}" opacity=".9"/>')
    o.append(f'<g stroke="{ink}" stroke-width="{.05*s}" stroke-linecap="round" opacity=".9">')
    for x in frange(bx + br, bx + bw - br, 0.3):
        o.append(f'<line x1="{x*s:.1f}" y1="{(by+.1)*s:.1f}" x2="{x*s:.1f}" y2="{(by+.34)*s:.1f}"/>')
        o.append(f'<line x1="{x*s:.1f}" y1="{(by+bh-.1)*s:.1f}" x2="{x*s:.1f}" y2="{(by+bh-.34)*s:.1f}"/>')
    for y in frange(by + br, by + bh - br, 0.3):
        o.append(f'<line x1="{(bx+.1)*s:.1f}" y1="{y*s:.1f}" x2="{(bx+.34)*s:.1f}" y2="{y*s:.1f}"/>')
        o.append(f'<line x1="{(bx+bw-.1)*s:.1f}" y1="{y*s:.1f}" x2="{(bx+bw-.34)*s:.1f}" y2="{y*s:.1f}"/>')
    o.append('</g>')
    # glazing bars: the panes are divided by two thin mullions the light passes between
    o.append(f'<g stroke="{ink}" stroke-width="{.06*s}" opacity=".55">')
    for x in (bx + bw / 2 - 2.6, bx + bw / 2 + 2.6):
        o.append(f'<line x1="{x*s:.1f}" y1="{(by+.45)*s:.1f}" x2="{x*s:.1f}" y2="{(by+bh-.45)*s:.1f}"/>')
    o.append('</g>')
    # the foot: the column hatched along its length (denser on the shadow side), the plinth's two steps hatched and
    # the lower one cross-hatched, each piece held by a firm outline, and a dark line under every step for its depth
    o.append(f'<g clip-path="url(#stemc)" stroke="{ink}" stroke-width="{.05*s}">')
    for (x0, y0, x1, y1) in hatch_lines(10.8, 18.9, 13.3, 20.5, 82, 0.17):
        o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}"/>')
    for (x0, y0, x1, y1) in hatch_lines(12.2, 18.9, 13.3, 20.5, -30, 0.2):
        o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}" opacity=".8"/>')
    o.append('</g>')
    o.append(f'<polygon points="{stem_pts}" fill="none" stroke="{ink}" stroke-width="{.14*s}" stroke-linejoin="round"/>')
    o.append(f'<g clip-path="url(#collarc)" stroke="{ink}" stroke-width="{.05*s}">')
    for (x0, y0, x1, y1) in hatch_lines(10.4, 18.4, 13.6, 19.0, 0, 0.14):
        o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}"/>')
    o.append('</g>')
    o.append(f'<g fill="none" stroke="{ink}" stroke-width="{.14*s}">{rect(COLLAR, .1)}</g>')
    for tier, clip, cross in ((TIER1, "tier1c", False), (TIER2, "tier2c", True)):
        o.append(f'<g clip-path="url(#{clip})" stroke="{ink}" stroke-width="{.05*s}">')
        for (x0, y0, x1, y1) in hatch_lines(tier[0], tier[1], tier[0] + tier[2], tier[1] + tier[3], 40, 0.17):
            o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}"/>')
        if cross:
            for (x0, y0, x1, y1) in hatch_lines(tier[0], tier[1], tier[0] + tier[2], tier[1] + tier[3], -40, 0.26):
                o.append(f'<line x1="{x0*s:.1f}" y1="{y0*s:.1f}" x2="{x1*s:.1f}" y2="{y1*s:.1f}" opacity=".85"/>')
        o.append('</g>')
        o.append(f'<g fill="none" stroke="{ink}" stroke-width="{.16*s}">{rect(tier, .1 if not cross else .14)}</g>')
        # the step's depth: a heavier line along its bottom edge
        o.append(f'<line x1="{(tier[0]+.15)*s:.1f}" y1="{(tier[1]+tier[3])*s:.1f}" x2="{(tier[0]+tier[2]-.15)*s:.1f}" y2="{(tier[1]+tier[3])*s:.1f}" stroke="{ink}" stroke-width="{.26*s}" stroke-linecap="round"/>')
    # the cross: the light itself, with a soft bloom behind it
    w, y0, y1, hx0, hx1, hy = CROSS
    cross = (f'<rect x="{(CX-w/2)*s}" y="{y0*s}" width="{w*s}" height="{(y1-y0)*s}" rx="{.06*s}"/>'
             f'<rect x="{hx0*s}" y="{(hy-w/2)*s}" width="{(hx1-hx0)*s}" height="{w*s}" rx="{.06*s}"/>')
    if theme == "dark":
        o.append(f'<circle cx="{CX*s}" cy="{CY*s}" r="{1.9*s}" fill="{warm}" opacity=".45" filter="url(#soft)"/>')
        o.append(f'<g fill="{warm}" opacity=".9" filter="url(#soft)">{cross}</g>')
        o.append(f'<g fill="#fffaf0">{cross}</g>')
    else:
        # on paper the light is the untouched paper: the rays stop short of a white core, and the cross is left
        # white too, held by a fine dark outline, the way an engraver keeps a highlight
        o.append(f'<radialGradient id="core" cx="{CX*s}" cy="{CY*s}" r="{2.6*s}" gradientUnits="userSpaceOnUse">'
                 f'<stop offset=".45" stop-color="{bg}" stop-opacity="1"/><stop offset="1" stop-color="{bg}" stop-opacity="0"/></radialGradient>')
        o.append(f'<circle cx="{CX*s}" cy="{CY*s}" r="{2.6*s}" fill="url(#core)"/>')
        o.append(f'<g fill="{bg}" stroke="{ink}" stroke-width="{.08*s}">{cross}</g>')
    o.append('</svg>')
    return "\n".join(o)


def frange(a, b, step):
    x = a
    while x <= b + 1e-9:
        yield x; x += step


def svg_lockup(theme="dark"):
    """The mark beside the wordmark, as the top bar sets it (serif, the Doré credit's quiet weight)."""
    ink = "#f5f0e6" if theme == "dark" else "#141210"; bg = "#07070a" if theme == "dark" else "#f4efe4"
    mark = svg_mark(theme, 512).split("\n", 1)[1].rsplit("</svg>", 1)[0]   # the inner elements
    mark = mark.replace(f'<rect width="512" height="512" fill="{bg}"/>', "")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 560" width="1600" height="560">'
            f'<rect width="1600" height="560" fill="{bg}"/>'
            f'<g transform="translate(40,24)">{mark}</g>'
            f'<text x="560" y="325" font-family="New York, Iowan Old Style, Charter, Georgia, serif" font-size="150" font-weight="600" letter-spacing="-2" fill="{ink}">Bible Lantern</text>'
            f'<text x="566" y="400" font-family="-apple-system, Helvetica Neue, Arial, sans-serif" font-size="34" letter-spacing="6" fill="{ink}" opacity=".55">THY WORD IS A LAMP UNTO MY FEET</text>'
            f'</svg>')


def render(svg_path, png_path, w, h):
    subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--no-first-run", "--disable-gpu",
                    f"--window-size={w},{h}", "--force-device-scale-factor=1", f"--screenshot={png_path}", f"file://{svg_path}"],
                   capture_output=True)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for theme in ("dark", "paper"):
        p = os.path.join(OUT, f"mark-{theme}.svg"); open(p, "w").write(svg_mark(theme, 1024)); render(p, p[:-4] + ".png", 1024, 1024)
        p = os.path.join(OUT, f"lockup-{theme}.svg"); open(p, "w").write(svg_lockup(theme)); render(p, p[:-4] + ".png", 1600, 560)
    # the app's copy: the dark mark with no ground, for the Home cover and the share image
    open(os.path.join(OUT, "mark-transparent.svg"), "w").write(svg_mark("dark", 1024, transparent=True))
    print("wrote", sorted(os.listdir(OUT)))
