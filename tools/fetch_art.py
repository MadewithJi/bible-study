#!/usr/bin/env python3
"""Fetch Gustave Doré's 1866 Bible engravings from Wikimedia Commons.

Inputs (src/art/):
  dore_commons.json     every plate in the Commons gallery (241, idx 142-160 are Apocrypha)
  dore_mapped_raw.json  passage mappings + an image-quality pass for the 222 in-canon plates
  dore.json             the curated result (single source of truth once it exists)

Outputs:
  src/art/dore.json               curated plates in canonical order (written if missing, or --recurate)
  app/data/art/<id>.jpg           longest side 1800px, JPEG q84, progressive
  app/data/art/<id>-s.jpg         longest side 560px, JPEG q80, progressive
  app/data/art.json               what the app reads

Idempotent and resumable: plates whose two JPEGs already exist are skipped
(unless --force, --only, or the chosen Commons file changed since the last run).
Wikimedia etiquette: descriptive User-Agent, sequential requests, at most
~1.7 requests/second, resized thumbnails from the API wherever they are big
enough, originals only when a crop needs more pixels than a thumbnail has.

Imaging pipeline per plate: download → crop (dore.json "crop", [l, t, r, b] in the chosen
file's original pixels; or, for a photographed book page, "quad": the four inner corners of
the engraving's frame, which are warped to a rectangle so a tilted or keystoned page loses
no wedge of the picture) → gentle border trim → resize
→ optional heal (spot repairs, in output pixels) → neutral tone (every plate: one
greyscale channel + autocontrast, so the whole set reads as one book whatever paper the
source was printed or photographed on) → save large and small JPEGs.

Usage:
  python3 tools/fetch_art.py                 # fetch whatever is missing, rebuild art.json
  python3 tools/fetch_art.py --limit 40      # do at most 40 plates this run (chunked)
  python3 tools/fetch_art.py --only dore-015,dore-173 --force
  python3 tools/fetch_art.py --recurate      # rebuild dore.json from the raw inputs + overrides
  python3 tools/fetch_art.py --no-fetch      # only (re)write the JSON files
  python3 tools/fetch_art.py --cache DIR     # keep downloaded sources in DIR (re-runs are free)
"""
import argparse
import hashlib
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "art"
COMMONS_JSON = SRC / "dore_commons.json"
MAPPED_JSON = SRC / "dore_mapped_raw.json"
DORE_JSON = SRC / "dore.json"
DATA = ROOT / "app" / "data"
KJV_DIR = DATA / "bibles" / "kjv"
OUT_DIR = DATA / "art"
ART_JSON = DATA / "art.json"

API = "https://commons.wikimedia.org/w/api.php"
UA = "BibleStudyLocal/1.0 (personal study app)"
MIN_INTERVAL = 0.6          # seconds between request starts (<= 2 requests/second)
API_BATCH = 25              # titles per imageinfo query
THUMB_STEPS = (1920, 3840)  # Wikimedia's standard thumbnail widths near what we need
MAIN_MAX, MAIN_Q = 1800, 84
SMALL_MAX, SMALL_Q = 560, 80
TONE_CUTOFF = 0.3           # percent clipped at each end by the neutral-tone autocontrast
LOWRES_BELOW = 1200         # art.json marks plates whose longest side is smaller ("lowres")
APOCRYPHA = range(142, 161)
CREDIT = ("Gustave Doré (1832–1883), engravings for La Grande Bible de Tours, 1866"
          " · Public domain · via Wikimedia Commons")

Image.MAX_IMAGE_PIXELS = 400_000_000  # trusted source; some Commons scans are huge

# --------------------------------------------------------------------------------------
# Reconciled corrections (review of the mapper + checker + resolver passes, with the
# plates viewed and, where noted, Doré's own 1874 Warsaw captions read). They override
# book/chapter/v1/v2/scene; ALSO_OVERRIDES / CONFIDENCE_OVERRIDES apply the "also" and
# confidence fixes stated in the same reconciliation notes.
# --------------------------------------------------------------------------------------
OVERRIDES = {
    15: (1, 21, 15, 16, "With the water spent and the empty bottle lying on the sand, Hagar kneels against a great rock with her arms raised over her head in grief, while Ishmael lies faint some distance away."),
    16: (1, 22, 6, 8, "Isaac climbs the rocky hillside with the wood for the burnt offering on his shoulders, as his father Abraham walks with him, staff in hand."),
    65: (7, 16, 15, 17, "Seated on a couch, Samson lifts a lock of his uncut hair as he tells Delilah all his heart, while she stands beside him with her eyes cast down."),
    84: (10, 12, 31, 31, "Before the walls of conquered Rabbah, the Ammonite captives lie cast down on the ground as iron-bladed chariots are driven over them. Doré follows the Latin reading of 12:31; the KJV reads “harrows of iron”, and the BSB says David put them to work with iron tools."),
    92: (11, 4, 29, 34, "The aged King Solomon, crowned and white-bearded, sits in thought with a pen in one hand and a written scroll in the other, surrounded by the writings of the wisdom God gave him."),
    129: (24, 45, 1, 5, "Faint with sorrow, Baruch the scribe sits slumped against a sunlit stone wall beside his scrolls, one hand pressed to his bowed head."),
    132: (27, 1, 1, 6, "Standing apart in thought amid the great buildings of Babylon, Daniel rests his hand on a written scroll while fellow captives from Judah walk and sit in sorrow behind him."),
    173: (40, 9, 32, 34, "A man possessed and unable to speak kneels at Jesus' side and reaches up to him, while the people look on and a group of Pharisees confer among themselves."),
    177: (42, 8, 2, 2, "Alone in a desolate ravine, Mary Magdalene kneels at a rock bearing a skull and lifts her eyes in penitent prayer, as later Christian tradition pictured the woman from whom seven devils had gone out."),
    178: (40, 12, 22, 23, "Jesus lays his hand on the head of a man possessed, blind and dumb, who sits gripping his staff on a step by the wall, while the people look on."),
    183: (40, 15, 32, 38, "In the wilderness, the disciples carry baskets of bread and fishes among the great multitude seated on the ground, handing food even to the little children, while Jesus stands in the distance."),
    185: (40, 4, 23, 24, "Kneeling on the steps of a colonnaded building, Jesus lays his hand on a limp child held in a woman's arms, as the sick, the lame and the suffering are brought to him and grave onlookers watch."),
    192: (40, 4, 23, 25, "Seated beneath a great tree, Jesus raises his hand toward heaven as he preaches the gospel of the kingdom to the people gathered about him, some standing and some kneeling with bowed heads."),
    193: (42, 15, 18, 20, "Ragged and weary, the prodigal son reaches his father's house and leans his bowed head on his arm against a stone pillar at the top of the steps, while beneath the vine-covered arbor the household sits in sorrow and two women on the balcony gaze out into the distance."),
    224: (44, 2, 1, 4, "On the day of Pentecost a sound as of a rushing mighty wind fills the house, cloven tongues like fire rest on each of the kneeling believers, and they are all filled with the Holy Spirit."),
    223: (41, 16, 19, 19, "While the apostles watch from the hillside, some pointing and some gazing upward, the risen Christ is taken up alone into heaven in radiant light."),
    238: (66, 12, 1, 3, "A great wonder in heaven: the woman clothed with the sun, crowned with stars, stands upon the moon amid the heavenly host, while armed angels descend against the great dragon coiling below. Doré titled the plate “The Crowned Virgin” and, following Marian imagery, shows her holding her child, whom John sees born and caught up to God (12:2–5)."),
    # ---- visual QA, 2026-09-28: each scene re-read against the plate itself ----
    19: (1, 24, 59, 61, "Rebekah sets out on a canopied camel with Abraham's servant and her maids, while her family at the town gate lift their hands in farewell and weep to see her go."),
    22: (1, 29, 9, 20, "At the well near Haran, Rachel stands with her water jar on her shoulder while Jacob, shepherd's staff in hand, sits watching over Laban's flock."),
    30: (2, 2, 3, 4, "The infant Moses lies in his ark of bulrushes, drifting among the reeds of the moonlit Nile, while angels hover above and keep watch over him."),
    38: (2, 19, 16, 20, "At the foot of Mount Sinai the people fall on their faces and lift their hands in awe as cloud and light rest on the mountain where the LORD has come down."),
    41: (4, 20, 7, 11, "Water streams from the rock Moses has struck, and the thirsty people crowd its banks to drink with their children and animals, as Moses stands above with his rod raised."),
    46: (6, 3, 14, 17, "The armed men of Israel, with camels and riders, file across the bed of the Jordan toward the far bank, where the host of Israel already stretches to the horizon."),
    # Doré's English Bible places this plate at Josh 5:9-15 (between the Jordan and Jericho),
    # so the passage stays; the scene describes what the plate shows (no sword, the whole host).
    47: (6, 5, 13, 15, "Near Jericho an angel stands on a height before the assembled host of Israel, one arm raised toward heaven, as many in the camp kneel and bow to the ground."),
    54: (7, 4, 21, 22, "Jael draws back the curtain of her tent to show Barak and his pursuing soldiers the man they seek: Sisera lying dead on the floor, slain with a tent peg."),
    58: (7, 9, 4, 5, "At dusk the slain sons of Gideon lie heaped upon the ground as Abimelech's armed band marches away along the horizon."),
    59: (7, 9, 52, 54, "Beneath the tower of Thebez, Abimelech lies bleeding beside the millstone a woman cast down on his head, as his soldiers gather over him."),
    60: (7, 11, 34, 35, "Jephthah's only daughter comes out to meet her returning father, dancing with arms flung wide as her companions play timbrels, cymbals, harp and trumpet."),
    62: (7, 14, 5, 6, "On the way down to Timnath, with the Spirit of the LORD upon him, Samson grapples a roaring young lion among the rocks and tears it apart with his bare hands."),
    73: (9, 10, 1, 1, "On the hilltop the young Saul kneels before the aged Samuel, who grips his staff and lifts his face and open hand toward heaven in blessing."),
    75: (9, 17, 49, 51, "Standing on the fallen giant beside his great sword, David holds Goliath's severed head aloft as the Israelites cheer and the Philistines flee."),
    79: (9, 24, 8, 11, "Outside the cave at En-gedi, David stands on a rock and holds up the piece of Saul's robe toward the king and his men on the cliff above."),
    91: (11, 10, 1, 3, "In Solomon's pillared hall the king stands by his throne and stretches out his hand in welcome as the queen of Sheba, her train borne by pages, approaches with attendants bearing gifts."),
    97: (11, 20, 29, 30, "Israel's chariots and spearmen drive through the fallen Syrian host at Aphek, the walled city rising on the hill behind."),
    107: (12, 19, 35, 35, "In the night the angel of the LORD strides sword in hand through the Assyrian camp beneath a lightning-torn sky, and Sennacherib's warriors and horses fall on every side."),
    109: (13, 21, 14, 16, "As the plague sweeps through Jerusalem, a robed elder stands with both arms lifted to heaven in intercession while the dying and the grieving lie around him."),
    114: (15, 9, 5, 6, "At the evening sacrifice Ezra, his garments torn, sinks down on the stone terrace with his head bowed low in grief and confession for the people, while the assembly gathers behind him."),
    116: (16, 8, 2, 6, "Standing on raised stone steps, Ezra holds up a tablet inscribed with the law and points to its words as he reads it aloud to the people gathered around and below him."),
    118: (17, 5, 1, 2, "Esther, in royal robes, comes unbidden into the king's inner court and, as in the Greek additions to Esther that Doré followed, sinks fainting into the arms of her maids, while Ahasuerus stands before his canopied throne."),
    121: (18, 1, 14, 20, "Messengers arrive one after another with news of Job's losses, one pointing back toward the burning fields, and Job stands stricken in his doorway with his hand pressed to his head while the women of his house fall to the ground in grief."),
    122: (18, 3, 1, 3, "Seated on a heap of straw in his affliction, Job lifts his arm toward heaven as he speaks, while Eliphaz, Bildad and Zophar stand and sit close beside him, one resting his chin on his hand as he listens."),
    127: (24, 1, 14, 16, "Under a storm-dark sky, Jeremiah sinks back against the stone steps, face lifted and one arm flung toward heaven, as he cries out the LORD's warning of disaster from the north, while listeners sit about him in sorrow."),
    180: (42, 8, 51, 55, "In the quiet room Jesus stands at the bedside and lays his hand on the brow of Jairus's daughter as she lies on her bed, while her mother kneels with her head bowed against it and three men look on from across the room."),
    189: (42, 10, 33, 34, "Moved with compassion, the Samaritan stops on the lonely road and lifts the man left half dead by robbers onto his own horse."),
    195: (42, 16, 19, 21, "While the rich man's feast goes on above, his servants drive the sore-covered beggar Lazarus down the palace steps with a raised switch, and the dogs gather around him."),
    196: (42, 18, 10, 13, "In the temple the proud Pharisee stands erect with his eyes raised, while the publican lies prostrate on the floor pleading for mercy, and Jesus, who tells the parable, appears with his disciples in the bright doorway."),
    202: (41, 14, 22, 24, "At the Passover table Jesus sits among the twelve with the bread and the cup before him, one hand raised as he speaks, while the disciples listen, some troubled and questioning among themselves."),
    209: (43, 19, 13, 15, "Standing beside the bound, thorn-crowned Jesus at the edge of the raised pavement, Pilate presents him to the crowd below, which cries out for his crucifixion."),
    212: (40, 27, 33, 33, "Arriving at Golgotha, Jesus has fallen beneath the cross, as Christian tradition pictures him; two men heave its weight from him as a mounted officer looks on, a grieving woman sinks down at his side, and soldiers and the crowd press on toward the place of a skull."),
    214: (42, 23, 33, 35, "Jesus hangs on the cross between the two criminals as a shaft of light breaks through the storm clouds, while the grieving women watch from beside the rock and mounted soldiers move below."),
    215: (43, 19, 18, 19, "At Golgotha soldiers drive the nails through Jesus' hands as he lies stretched on the cross, while behind them one of the two criminals is already being bound to his upright cross."),
    # Doré's 1874 Warsaw caption for this print is 'Połów cudowny', Luke 5:6, and the page is
    # bound in Luke between 89480558 (Luke 2) and 89481200 (Luke 5:1-3).
    222: (42, 5, 4, 7, "At Jesus' word the fishermen let down their nets again and haul in so great a multitude of fish that the net begins to break, as Jesus stands by with his hand outstretched."),
    229: (44, 9, 3, 7, "Near Damascus a light from heaven strikes Saul to the ground, and his armed companions fall and cower around him as the voice of Jesus asks why he persecutes him."),
    # ---- audit, 2026-10-02: tradition hedged, the KJV quoted exactly, scenes matched to the plate ----
    211: (41, 15, 20, 21, "As Christian tradition pictures it, Jesus sinks beneath the weight of the cross on the road to Golgotha, and Simon of Cyrene is compelled to carry it."),
    218: (40, 27, 59, 59, "The lifeless body of Jesus lies on a linen shroud while his followers keep watch before burial; as Christian tradition pictures the scene, his grieving mother is among them."),
    200: (40, 22, 19, 21, "Shown a Roman coin by those seeking to trap him, Jesus asks whose image it bears and answers, “Render therefore unto Cæsar the things which are Cæsar’s; and unto God the things that are God’s.”"),
    188: (43, 8, 3, 9, "The accused woman crouches beside Jesus, who has written on the ground and answers her accusers, “He that is without sin among you, let him first cast a stone at her.”"),
    87: (10, 21, 8, 10, "Rizpah spreads sackcloth on the rock and guards the bodies of the hanged men, two of them her own sons, from birds by day and beasts by night."),
    96: (11, 19, 5, 7, "Sitting beneath the juniper tree, Elijah looks up as an angel comes down to him with a jar of water and bread, bidding him arise and eat."),
    10: (1, 11, 1, 9, "As the LORD confounds their language, the builders of the great tower in Shinar fall into confusion and despair, one man flinging his arms up toward heaven, while the work lies abandoned behind them."),
    29: (1, 46, 5, 7, "The aged Jacob sets out for Egypt with his household, their flocks and their water jars; Doré shows him riding high on a camel, where Genesis tells of the wagons Pharaoh sent to carry him."),
}
ALSO_OVERRIDES = {
    84: [[13, 20, 3, 3]],                       # "Also: 1 Chr 20:3"
    173: [],                                    # drop Mark 1:23-27 (a synagogue scene)
    178: [[42, 11, 14, 14]],                    # keep only Luke 11:14
    183: [[41, 8, 6, 9]],                       # four thousand, not the five-thousand parallels
    185: [[40, 15, 29, 31]],                    # Matt 15:29-31 as a secondary link
    223: [[42, 24, 50, 51], [44, 1, 9, 10]],    # Luke 24:50-51, Acts 1:9-10
    238: [[66, 12, 4, 5], [66, 12, 7, 9]],      # the child; Michael's angels and the dragon
    19: [[1, 24, 63, 67]],                      # the meeting itself, which the plate leads to
    46: [[6, 4, 12, 13]],                       # the armed men who passed over before the people
    122: [[18, 2, 11, 13]],                     # the friends arrive; none speaks for seven days (2:13)
    212: [[41, 15, 22, 22], [42, 23, 33, 33], [43, 19, 17, 17]],
    222: [],      # not John 21:6-11: a different draught (Jesus on the shore, the net not broken)
    176: [],      # not Luke 6:17-23: there Jesus stands in the plain, not seated on the mount
}
CONFIDENCE_OVERRIDES = {132: "high"}  # confirmed by Doré's caption "DANIEL. Dan. 1, 1."

# Titles: Commons gallery titles that are misspelled, that name a different moment from
# the one the plate shows, or that contradict the passage.
TITLE_OVERRIDES = {
    9: "Noah Curses Canaan",                           # Gen 9:25: the curse falls on Canaan, not Ham
    19: "Rebekah Sets Out to Meet Isaac",             # the send-off (Gen 24:59-61), not the meeting
    41: "Moses Strikes the Rock",                      # "at Horeb" contradicted the Num 20 passage
    69: "The Benjaminites Seize the Daughters of Shiloh",  # vineyards of Shiloh, not Jabesh-gilead
    173: "The Dumb Man Possessed",                     # 1874 caption 'Jezus uzdrawia niemego, Mat. 9, 32'
    228: "Martyrdom of Stephen",                       # Commons: "Martydom"
    230: "Peter in the House of Cornelius",            # Commons: "Peter the House of"
    33: "The Fifth Plague: Livestock Disease",        # Commons file names cannot hold a colon
    34: "The Ninth Plague: Darkness",
    182: "The Daughter of Herodias Receiving the Head of John the Baptist",  # Matt 14:6, Mark 6:22
    238: "The Woman Clothed with the Sun: A Vision of John",  # Rev 12:1; Doré: "The Crowned Virgin"
}

# Plates left out of the curated set, with the reason.
EXCLUDE = {
    178: "only a 329x407 sepia GIF exists; soft at any size, and its subject is unverified "
         "(Doré's 'Dumb Man Possessed' is the kneeling-man plate, dore-173)",
}

# Source fixes. FILE_FIXES swaps the Commons source file. CROP_FIXES is [l, t, r, b] in the
# chosen file's original pixels: just inside the frame rule, so no paper sliver or bowed
# rule shows at an edge. QUAD_FIXES is for photographed book pages (tilted and slightly
# keystoned): the engraving's corners [[x, y] top-left, top-right, bottom-right,
# bottom-left], just inside the frame rule, in the file's original pixels; the quad is
# warped to a rectangle, which keeps the signatures on the bottom line whole. The numeric
# tables are generated from measurements (see the note above each) and live at the end of
# this block.
FILE_FIXES = {}
CROP_FIXES = {}
QUAD_FIXES = {}

# Spot repairs in output (large-image) pixels: [x, y, r, dx, dy] replaces the disc of radius
# r at (x, y) with the hatching at (x + dx, y + dy), feathered at the rim.
HEAL = {
    168: [[294, 1422, 8, 18, 0]],   # dark foxing dot in the river (Baptism of Jesus)
}

# CROP_FIXES, visual QA 2026-09-28: the scans' frame rules are bowed (page curvature), so a
# straight trim left paper wedges and rule slivers at the edges. Boxes were measured on the
# large images (a 2D paper/rule detector: light, locally flat paper rows from the edge, then
# the dark rule, taking the deepest point of the bow), checked by eye along every cut side,
# and mapped back to each file's original pixels through the exact thumbnail/trim/resize
# the image went through. dore-108 also drops rows the Commons file repeats below a
# stitching seam (a second, cut "G. Doré" signature), and dore-182 drops the black frame
# and paper of its 1891 scan.
CROP_FIXES.update({
    1: [17, 0, 2300, 2903], 2: [29, 18, 2305, 2878], 3: [22, 17, 2304, 2919],
    4: [26, 10, 2327, 2903], 6: [38, 15, 2313, 2895], 7: [31, 12, 2283, 2854],
    8: [17, 9, 2316, 2901], 9: [23, 34, 2317, 2937], 10: [26, 17, 2297, 2882],
    11: [0, 9, 2617, 2058], 12: [28, 24, 2286, 2876], 13: [18, 10, 2326, 2901],
    14: [34, 13, 2309, 2886], 15: [0, 16, 2264, 2874], 16: [13, 12, 2286, 2904],
    17: [18, 26, 2305, 2902], 18: [15, 22, 2311, 2946], 19: [25, 13, 2343, 2903],
    20: [0, 12, 2284, 2933], 21: [26, 18, 2299, 2873], 22: [0, 9, 2303, 2915],
    23: [18, 0, 2307, 2890], 24: [18, 11, 1545, 1903], 25: [24, 18, 2309, 2867],
    26: [25, 12, 2310, 2891], 27: [17, 0, 2303, 2903], 28: [15, 13, 2307, 2903],
    30: [0, 9, 2604, 2087], 31: [15, 18, 2336, 2911], 32: [13, 17, 2321, 2908],
    33: [14, 12, 2618, 2067], 34: [17, 82, 2627, 2108], 35: [0, 0, 2308, 2910],
    36: [14, 14, 2307, 2915], 37: [0, 15, 2589, 2072], 38: [0, 0, 2603, 2078],
    39: [0, 23, 2292, 2898], 40: [18, 17, 2322, 2922], 41: [0, 18, 2317, 2921],
    42: [23, 22, 2334, 2914], 43: [19, 10, 2290, 2870], 44: [0, 31, 2266, 2904],
    45: [0, 0, 2310, 2914], 46: [17, 11, 2619, 2084], 47: [28, 12, 2324, 2919],
    48: [12, 20, 2291, 2910], 49: [0, 10, 2301, 2916], 50: [19, 22, 2317, 2922],
    51: [0, 18, 2304, 2943], 52: [27, 10, 2346, 2918], 53: [0, 9, 2627, 2095],
    54: [22, 0, 2316, 2915], 55: [38, 13, 2319, 2902], 56: [0, 0, 2583, 2044],
    57: [0, 0, 2644, 2105], 58: [0, 0, 2270, 2902], 59: [0, 23, 2338, 2930],
    60: [21, 17, 2339, 2926], 61: [0, 0, 2647, 2082], 62: [0, 10, 2340, 2907],
    63: [10, 0, 2298, 2887], 64: [0, 12, 2616, 2080], 65: [28, 0, 2335, 2901],
    66: [15, 0, 2301, 2899], 69: [0, 20, 2303, 2928], 70: [12, 26, 2340, 2922],
    71: [19, 15, 2325, 2927], 72: [31, 21, 2615, 2092], 73: [0, 0, 2289, 2880],
    75: [13, 0, 2299, 2908], 77: [0, 9, 2333, 2926], 80: [0, 13, 2310, 2925],
    81: [21, 27, 2312, 2910], 82: [13, 15, 2328, 2921], 83: [0, 21, 2301, 2888],
    84: [0, 11, 2606, 2104], 85: [18, 0, 2317, 2888], 86: [18, 0, 2331, 2902],
    88: [0, 15, 2298, 2899], 89: [5, 0, 2342, 2910], 91: [22, 14, 2347, 2943],
    92: [20, 0, 2367, 2921], 93: [0, 22, 2277, 2926], 97: [17, 21, 2627, 2115],
    98: [0, 0, 2305, 2887], 100: [0, 21, 2284, 2907], 101: [0, 0, 2284, 2871],
    103: [0, 18, 2290, 2886], 104: [0, 0, 2345, 2902], 105: [22, 0, 2303, 2901],
    106: [23, 27, 2357, 2926], 108: [20, 7, 2349, 2931], 109: [0, 20, 2293, 2933],
    111: [0, 12, 2323, 2927], 112: [18, 0, 2328, 2934], 113: [0, 12, 2278, 2871],
    114: [0, 27, 2277, 2892], 116: [0, 17, 2281, 2907], 117: [20, 32, 2340, 2951],
    118: [0, 0, 2303, 2902], 119: [20, 13, 2310, 2911], 120: [13, 20, 2269, 2869],
    121: [22, 18, 2334, 2933], 122: [21, 0, 2303, 2887], 123: [20, 0, 2290, 2862],
    124: [29, 0, 2638, 2081], 125: [0, 0, 2300, 2897], 126: [15, 0, 2311, 2873],
    128: [20, 12, 2357, 2927], 129: [29, 0, 2326, 2868], 130: [0, 0, 2295, 2895],
    131: [34, 0, 2322, 2895], 132: [37, 0, 2358, 2928], 134: [0, 21, 2345, 2927],
    136: [13, 0, 2593, 2049], 137: [27, 33, 2312, 2917], 139: [38, 18, 2313, 2870],
    140: [22, 0, 2649, 2131], 141: [0, 0, 2287, 2885], 182: [19, 24, 2622, 3237],
})

# FILE_FIXES, visual QA 2026-09-28: the same compositions from the Polona scans of the 1874
# Warsaw Bible, vol. 2 (clean, full resolution, signed), replacing weaker copies.
FILE_FIXES.update({
    # old: a coarse 1890s halftone with its printed caption
    176: "Pismo Swiete Starego i Nowego Testamentu. T. 2 1874 (89476389).jpg",
    # old: a wide 1869 re-cut with a caption band; this is Doré's own plate
    184: "Pismo Swiete Starego i Nowego Testamentu. T. 2 1874 (89476805).jpg",
    # old: a 1920 halftone reprint with a retouch patch
    201: "Pismo Swiete Starego i Nowego Testamentu. T. 2 1874 (89479480).jpg",
    # old: printed caption and paper margins
    205: "Pismo Swiete Starego i Nowego Testamentu. T. 2 1874 (89478636).jpg",
    # old: blue-grey cast; this one has twice the resolution
    239: "Pismo Swiete Starego i Nowego Testamentu. T. 2 1874 (89486816).jpg",
})

# QUAD_FIXES, visual QA 2026-09-28: every photographed Polona page (1874 vol. 2 and the 1892
# New Testament) is tilted by up to about 1.5 degrees and a little keystoned, so an upright
# crop inside the frame cut wedges off the picture, most visibly the engravers' signatures
# on the bottom line. Each quad follows the four frame rules (fitted to 40 samples per side,
# allowing for a slight bow) and sits just inside the rule and the hairline gap after it.
QUAD_FIXES.update({
    161: [[802, 1751], [4118, 1706], [4195, 5857], [837, 5912]],
    162: [[778, 1701], [4117, 1664], [4192, 5791], [808, 5850]],
    163: [[872, 1652], [4155, 1625], [4179, 5719], [881, 5719]],
    164: [[488, 970], [3776, 979], [3796, 5069], [463, 5063]],
    165: [[802, 1616], [4110, 1590], [4132, 5730], [827, 5720]],
    166: [[753, 1600], [4102, 1600], [4162, 5709], [784, 5781]],
    167: [[817, 1634], [4140, 1619], [4140, 5770], [817, 5748]],
    168: [[825, 1678], [4126, 1648], [4133, 5801], [828, 5782]],
    169: [[785, 1662], [4055, 1638], [4069, 5752], [791, 5737]],
    170: [[869, 1725], [4203, 1746], [4203, 5906], [859, 5944]],
    171: [[754, 1708], [4119, 1676], [4175, 5870], [790, 5916]],
    172: [[869, 1620], [4209, 1641], [4250, 5759], [891, 5809]],
    173: [[812, 1657], [4231, 1626], [4261, 5872], [823, 5861]],
    174: [[737, 1676], [4069, 1728], [4127, 5829], [784, 5907]],
    175: [[844, 1628], [4241, 1579], [4279, 5876], [868, 5874]],
    176: [[722, 1618], [4154, 1578], [4172, 5832], [733, 5832]],
    177: [[836, 1830], [4185, 1761], [4273, 5947], [905, 6013]],
    179: [[754, 1686], [4169, 1644], [4232, 5879], [804, 5934]],
    180: [[793, 1752], [4190, 1687], [4261, 5857], [855, 5915]],
    181: [[818, 1601], [4107, 1601], [4159, 5701], [843, 5767]],
    183: [[804, 1773], [4122, 1711], [4208, 5836], [874, 5907]],
    184: [[1771, 855], [5975, 850], [6025, 4223], [1745, 4261]],
    186: [[839, 1664], [4166, 1644], [4234, 5796], [881, 5851]],
    187: [[841, 1721], [4156, 1705], [4209, 5831], [887, 5884]],
    188: [[933, 1665], [4252, 1682], [4290, 5795], [956, 5847]],
    189: [[909, 1764], [4123, 1703], [4216, 5885], [956, 5941]],
    190: [[706, 1792], [4049, 1742], [4101, 5934], [742, 5953]],
    191: [[798, 1624], [4160, 1553], [4249, 5753], [856, 5816]],
    192: [[825, 1638], [4150, 1613], [4156, 5761], [830, 5737]],
    193: [[1861, 879], [5974, 839], [6028, 4157], [1899, 4212]],
    194: [[815, 1780], [4118, 1730], [4180, 5840], [859, 5874]],
    196: [[718, 1675], [4077, 1618], [4134, 5813], [764, 5846]],
    197: [[748, 1666], [4114, 1622], [4186, 5825], [788, 5883]],
    198: [[952, 1768], [4240, 1780], [4288, 5842], [987, 5897]],
    199: [[838, 1601], [4190, 1598], [4252, 5698], [886, 5760]],
    201: [[767, 1719], [4114, 1704], [4160, 5891], [782, 5921]],
    202: [[851, 1633], [4175, 1611], [4222, 5705], [905, 5767]],
    203: [[766, 1641], [4104, 1580], [4168, 5755], [817, 5809]],
    204: [[794, 1607], [4078, 1610], [4095, 5694], [796, 5694]],
    205: [[761, 1718], [4083, 1687], [4126, 5825], [791, 5871]],
    206: [[665, 1804], [4016, 1795], [4124, 5929], [749, 5990]],
    207: [[826, 1710], [4166, 1732], [4213, 5856], [849, 5936]],
    208: [[869, 1704], [4179, 1698], [4241, 5775], [905, 5857]],
    209: [[908, 1717], [4244, 1729], [4285, 5853], [927, 5916]],
    210: [[697, 1684], [4082, 1632], [4153, 5898], [741, 5958]],
    211: [[733, 1741], [4103, 1756], [4125, 5877], [719, 5914]],
    212: [[1060, 525], [5092, 559], [5064, 3802], [1043, 3775]],
    213: [[865, 1704], [4188, 1710], [4242, 5825], [891, 5868]],
    214: [[762, 1721], [4138, 1651], [4222, 5887], [822, 5958]],
    215: [[902, 1702], [4196, 1697], [4238, 5797], [924, 5813]],
    216: [[852, 1663], [4171, 1692], [4210, 5829], [852, 5867]],
    217: [[834, 1713], [4162, 1704], [4216, 5826], [876, 5884]],
    218: [[775, 1730], [4131, 1750], [4169, 5838], [796, 5902]],
    219: [[851, 1702], [4198, 1692], [4218, 5862], [882, 5877]],
    220: [[753, 1847], [4099, 1825], [4153, 5981], [779, 6017]],
    221: [[891, 1668], [4252, 1682], [4266, 5828], [882, 5850]],
    222: [[793, 1730], [4110, 1742], [4164, 5837], [821, 5892]],
    223: [[759, 1761], [4079, 1715], [4160, 5881], [792, 5935]],
    224: [[806, 1738], [4172, 1746], [4194, 5878], [822, 5898]],
    225: [[853, 1699], [4199, 1709], [4225, 5840], [869, 5872]],
    226: [[866, 1765], [4134, 1763], [4156, 5879], [886, 5930]],
    229: [[831, 1654], [4161, 1629], [4226, 5742], [892, 5803]],
    230: [[845, 1702], [4189, 1674], [4277, 5821], [904, 5901]],
    231: [[802, 1704], [4152, 1643], [4237, 5825], [884, 5903]],
    234: [[771, 1754], [4090, 1720], [4179, 5853], [832, 5929]],
    235: [[890, 1737], [4269, 1685], [4366, 5800], [974, 5900]],
    236: [[798, 1777], [4137, 1749], [4212, 5873], [859, 5934]],
    238: [[796, 1727], [4127, 1688], [4184, 5859], [843, 5921]],
    239: [[844, 1737], [4180, 1676], [4251, 5808], [900, 5856]],
    240: [[869, 1803], [4213, 1765], [4268, 5943], [910, 5974]],
    241: [[880, 1673], [4223, 1667], [4245, 5828], [891, 5850]],
})


# ------------------------------------------------------------------------------ helpers
def log(msg=""):
    print(msg, flush=True)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_atomic(path, text):
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def commons_page(name):
    """File page URL, encoded the way MediaWiki does (wfUrlencode)."""
    return "https://commons.wikimedia.org/wiki/File:" + urllib.parse.quote(
        name.replace(" ", "_"), safe=";@$!*(),/~:")


def plate_id(idx):
    return "dore-%03d" % idx


# ------------------------------------------------------------------------------ curation
def verse_counts():
    """{book: [verses in ch1, ch2, ...]} from the bundled KJV."""
    counts = {}
    for p in sorted(KJV_DIR.glob("[0-9][0-9].json")):
        book = int(p.stem)
        chapters = load_json(p)
        counts[book] = [len(chapters[str(c)]) for c in range(1, len(chapters) + 1)]
    return counts


def check_ref(ref, counts):
    b, c, v1, v2 = ref
    if b not in counts or not 1 <= c <= len(counts[b]):
        return "no such book/chapter"
    if not 1 <= v1 <= v2 <= counts[b][c - 1]:
        return "verses %d-%d outside 1-%d" % (v1, v2, counts[b][c - 1])
    return None


def curate():
    """Raw inputs + reconciled overrides -> list of curated plates in canonical order."""
    commons = {p["idx"]: p for p in load_json(COMMONS_JSON)}
    raw = load_json(MAPPED_JSON)
    quality = {q["idx"]: q for q in raw["quality"]}
    plates = []
    for m in raw["mappings"]:
        idx = m["idx"]
        if idx in APOCRYPHA or idx in EXCLUDE:
            continue
        c = commons[idx]
        book, chapter, v1, v2, scene = m["book"], m["chapter"], m["v1"], m["v2"], m["scene"]
        if idx in OVERRIDES:
            book, chapter, v1, v2, scene = OVERRIDES[idx]
        ref = [book, chapter, v1, v2]
        also = ALSO_OVERRIDES.get(idx, m.get("also") or [])
        seen, clean_also = {tuple(ref)}, []
        for a in also:                      # drop duplicates and repeats of the primary
            if tuple(a) not in seen:
                seen.add(tuple(a))
                clean_also.append(list(a))
        q = quality.get(idx, {})
        rep = (q.get("replacement_file") or "").strip()
        use_rep = bool(rep) and not q.get("keep", True)
        chosen = rep if use_rep else c["file"]
        crop = q.get("crop")  # [l, t, r, b] in the chosen file's original pixels
        if idx in FILE_FIXES and FILE_FIXES[idx] != chosen:
            chosen, crop = FILE_FIXES[idx], None   # a crop never carries over to another file
        if idx in CROP_FIXES:
            crop = CROP_FIXES[idx]
        quad = QUAD_FIXES.get(idx)
        if quad:                                   # the quad's bounding box sizes the download
            crop = [min(x for x, _ in quad), min(y for _, y in quad),
                    max(x for x, _ in quad), max(y for _, y in quad)]
        plate = {
            "id": plate_id(idx),
            "idx": idx,
            "title": TITLE_OVERRIDES.get(idx, c["title"]),
            "scene": scene,
            "ref": ref,
            "also": clean_also,
            "commons_file": chosen,
            "commons_page": commons_page(chosen),
            "crop": list(crop) if crop else None,
            "confidence": CONFIDENCE_OVERRIDES.get(idx, m["confidence"]),
        }
        if quad:
            plate["quad"] = [list(pt) for pt in quad]
        if idx in HEAL:
            plate["heal"] = [list(h) for h in HEAL[idx]]
        plates.append(plate)
    plates.sort(key=lambda p: (p["ref"][0], p["ref"][1], p["ref"][2], p["ref"][3], p["idx"]))
    return plates


def validate(plates):
    counts = verse_counts()
    problems = []
    ids = set()
    for p in plates:
        if p["id"] in ids:
            problems.append("%s: duplicate id" % p["id"])
        ids.add(p["id"])
        for r in [p["ref"]] + p["also"]:
            err = check_ref(r, counts)
            if err:
                problems.append("%s: %s %s" % (p["id"], r, err))
        if p["crop"]:
            l, t, r, b = p["crop"]
            if not (0 <= l < r and 0 <= t < b):
                problems.append("%s: bad crop %s" % (p["id"], p["crop"]))
        qd = p.get("quad")
        if qd is not None:
            ok = (isinstance(qd, list) and len(qd) == 4 and all(len(pt) == 2 for pt in qd)
                  and qd[0][0] < qd[1][0] and qd[3][0] < qd[2][0]      # left of right
                  and qd[0][1] < qd[3][1] and qd[1][1] < qd[2][1])     # top above bottom
            if not ok:
                problems.append("%s: bad quad %r" % (p["id"], qd))
        for h in p.get("heal") or []:
            if not (isinstance(h, list) and len(h) == 5 and h[2] > 0 and (h[3] or h[4])):
                problems.append("%s: bad heal %r" % (p["id"], h))
    return problems


OPTIONAL_KEYS = ("quad", "heal")


def dump_dore(plates):
    lines = []
    for p in plates:
        q = {k: p[k] for k in ("id", "idx", "title", "scene", "ref", "also", "commons_file",
                               "commons_page", "crop", "confidence")}
        q.update({k: p[k] for k in OPTIONAL_KEYS if p.get(k)})
        lines.append("  " + json.dumps(q, ensure_ascii=False, separators=(", ", ": ")))
    return "[\n" + ",\n".join(lines) + "\n]\n"


# ------------------------------------------------------------------------------ network
class Net:
    def __init__(self, cache_dir=None):
        self.last = 0.0
        self.requests = 0
        self.bytes = 0
        self.cache = Path(cache_dir) if cache_dir else None
        if self.cache:
            self.cache.mkdir(parents=True, exist_ok=True)

    def get(self, url, attempts=4):
        """GET with retries. Image downloads (not API queries) go through the optional
        on-disk cache, keyed by URL, so repeated runs do not fetch a file twice."""
        cached = None
        if self.cache and not url.startswith(API):
            cached = self.cache / (hashlib.sha1(url.encode("utf-8")).hexdigest() + ".bin")
            if cached.exists() and cached.stat().st_size > 0:
                return cached.read_bytes()
        data = self._get(url, attempts)
        if cached:
            tmp = cached.with_name(cached.name + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, cached)
        return data

    def _get(self, url, attempts):
        err = None
        for attempt in range(attempts):
            wait = self.last + MIN_INTERVAL - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            self.requests += 1
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                self.bytes += len(data)
                return data
            except urllib.error.HTTPError as e:
                err = e
                if e.code in (429, 500, 502, 503, 504):
                    retry = e.headers.get("Retry-After")
                    delay = int(retry) if retry and retry.isdigit() else 5 * (attempt + 1)
                    delay = min(delay, 90)
                    log("    HTTP %d, waiting %ds" % (e.code, delay))
                    time.sleep(delay)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                err = e
                time.sleep(3 * (attempt + 1))
        raise RuntimeError("giving up on %s: %s" % (url[:120], err))

    def imageinfo(self, names, width):
        """{file name: imageinfo dict} for the given Commons file names."""
        out = {}
        for i in range(0, len(names), API_BATCH):
            chunk = names[i:i + API_BATCH]
            params = {
                "action": "query", "format": "json", "formatversion": "2",
                "prop": "imageinfo", "iiprop": "url|size|mime", "iiurlwidth": str(width),
                "maxlag": "5", "titles": "|".join("File:" + n for n in chunk),
            }
            for _ in range(4):
                data = json.loads(self.get(API + "?" + urllib.parse.urlencode(params)))
                if data.get("error", {}).get("code") == "maxlag":
                    time.sleep(5)
                    continue
                break
            q = data.get("query", {})
            # map the API's normalised titles back to the exact names we asked for
            norm = {n["to"]: n["from"] for n in q.get("normalized", [])}
            for page in q.get("pages", []):
                name = norm.get(page["title"], page["title"]).split(":", 1)[1]
                if page.get("missing") or not page.get("imageinfo"):
                    out[name] = None
                else:
                    out[name] = page["imageinfo"][0]
        return out


# ------------------------------------------------------------------------------ imaging
def to_rgb(im):
    """Any Commons image (greyscale, paletted GIF, PNG with alpha, 16-bit, CMYK) -> RGB."""
    if getattr(im, "n_frames", 1) > 1:
        im.seek(0)
    im = ImageOps.exif_transpose(im)
    icc = im.info.get("icc_profile")
    if im.mode in ("I;16", "I;16B", "I;16L", "I"):
        im = im.point(lambda v: v * (1 / 256)).convert("L")
    if im.mode == "1":
        im = im.convert("L")
    if im.mode in ("P", "PA", "LA", "RGBA") or "transparency" in im.info:
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.getchannel("A"))
        return bg
    if icc and im.mode in ("RGB", "CMYK"):
        try:
            from PIL import ImageCms
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            desc = ImageCms.getProfileDescription(src) or ""
            if "srgb" not in desc.lower().replace(" ", ""):
                return ImageCms.profileToProfile(im, src, ImageCms.createProfile("sRGB"),
                                                 outputMode="RGB")
        except Exception:
            pass
    return im.convert("RGB")


def _blank(g, box):
    """True if a 1px strip is near-uniform (paper margin or scanner bed, not engraving)."""
    h = g.crop(box).histogram()
    n = sum(h)
    acc, med = 0, 0
    for i, c in enumerate(h):
        acc += c
        if acc * 2 >= n:
            med = i
            break
    inside = sum(h[max(0, med - 24):min(255, med + 24) + 1])
    return inside >= n * 0.995


def trim_borders(im):
    """Gently trim uniform bands at the edges. Only when clearly a border: at least 2px
    of near-uniform lines, and no more than 8% of that side (a longer blank band may be
    part of the picture, so it is left alone). Returns (image, [l, t, r, b] trimmed)."""
    g = im.convert("L")
    w, h = g.size
    trimmed = [0, 0, 0, 0]

    def band(n_lines, strip):
        limit = max(2, int(n_lines * 0.08))
        k = 0
        while k <= limit and _blank(g, strip(k)):
            k += 1
        return k if 2 <= k <= limit else 0

    top = band(h, lambda k: (0, k, w, k + 1))
    bottom = band(h, lambda k: (0, h - 1 - k, w, h - k))
    y0, y1 = top, h - bottom
    left = band(w, lambda k: (k, y0, k + 1, y1))
    right = band(w, lambda k: (w - 1 - k, y0, w - k, y1))
    trimmed = [left, top, right, bottom]
    if any(trimmed) and (w - left - right) > w * 0.8 and (h - top - bottom) > h * 0.8:
        return im.crop((left, top, w - right, h - bottom)), trimmed
    return im, [0, 0, 0, 0]


def unwarp(im, quad):
    """Warp the quadrilateral `quad` ([[x, y] TL, TR, BR, BL] in `im` pixels) to an upright
    rectangle as wide and tall as the quad's mean side lengths."""
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = quad
    w = (math.hypot(x1 - x0, y1 - y0) + math.hypot(x2 - x3, y2 - y3)) / 2
    h = (math.hypot(x3 - x0, y3 - y0) + math.hypot(x2 - x1, y2 - y1)) / 2
    # Image.QUAD takes the source corners in the order upper-left, lower-left, lower-right,
    # upper-right
    return im.transform((round(w), round(h)), Image.QUAD,
                        (x0, y0, x3, y3, x2, y2, x1, y1), resample=Image.BICUBIC)


def heal(im, spots):
    """Replace small blemishes (foxing dots) with neighbouring hatching, feathered at the rim.
    Each spot is [x, y, r, dx, dy] in the image's own pixels."""
    im = im.copy()
    for x, y, r, dx, dy in spots:
        pad = r + 3
        src = im.crop((x + dx - pad, y + dy - pad, x + dx + pad + 1, y + dy + pad + 1))
        mask = Image.new("L", src.size, 0)
        ImageDraw.Draw(mask).ellipse((pad - r, pad - r, pad + r, pad + r), fill=255)
        im.paste(src, (x - pad, y - pad), mask.filter(ImageFilter.GaussianBlur(1.2)))
    return im


def neutral_tone(im):
    """The one tone every plate shares: a single grey channel with its levels stretched
    (TONE_CUTOFF % clipped at each end), saved as RGB. The red channel stands in for
    luminance: on these one-ink prints it follows the ink-to-paper ramp just as luma does,
    but it all but ignores the yellow-brown of aged paper, foxing and water stains. For the
    neutral (greyscale) sources R == G == B, so it is exactly their luma."""
    g = im.getchannel("R") if im.mode == "RGB" else im.convert("L")
    return ImageOps.autocontrast(g, cutoff=TONE_CUTOFF).convert("RGB")


def fit(size, longest):
    w, h = size
    s = min(1.0, longest / max(w, h))
    return max(1, round(w * s)), max(1, round(h * s))


def save_jpeg(im, path, quality):
    tmp = path.with_name(path.name + ".tmp")
    im.save(tmp, "JPEG", quality=quality, progressive=True, optimize=True)
    os.replace(tmp, path)


def thumb_step(needed_w, src_w):
    """Smallest standard thumbnail width that gives at least needed_w pixels, or None
    when only the original will do."""
    if needed_w >= src_w:
        return None
    for s in THUMB_STEPS:
        if s >= needed_w:
            return s if s < src_w else None
    return None


# ------------------------------------------------------------------------------ fetching
def plan(plate, info):
    """Decide what to download for a plate: (width step or None for original, why)."""
    W, H = info["width"], info["height"]
    if plate["crop"]:
        l, t, r, b = plate["crop"]  # in the chosen file's original pixels (W x H)
        clong = max(r - l, b - t)
        want = min(MAIN_MAX, clong)
        needed = math.ceil(W * want / clong * 1.01)
    else:
        needed = math.ceil(W * min(1.0, MAIN_MAX / max(W, H)))
    return thumb_step(needed, W)


def process(plate, info, net, force_original=False):
    W, H = info["width"], info["height"]
    step = None if force_original else plan(plate, info)
    url = info["url"] if step is None else info["_thumbs"].get(step)
    if not url:
        url, step = info["url"], None
    data = net.get(url)
    src = Image.open(io.BytesIO(data))
    src.load()
    fmt = src.format
    im = to_rgb(src)
    got = im.size
    how = ("original %dx%d" % got) if step is None else ("thumb %d → %dx%d" % (step, got[0], got[1]))
    warn = []
    if abs(got[0] / got[1] - W / H) > 0.01:
        warn.append("aspect differs from Commons (%dx%d)" % (W, H))
    if plate.get("quad"):
        sx, sy = got[0] / W, got[1] / H
        im = unwarp(im, [(x * sx, y * sy) for x, y in plate["quad"]])
        l, t, r, b = plate["crop"]
        clong = max(r - l, b - t)
        if step is not None and max(im.size) < min(MAIN_MAX, clong) - 2:
            return None, "thumbnail too small for crop"
    elif plate["crop"]:
        l, t, r, b = plate["crop"]
        if r > W or b > H:
            warn.append("crop %s exceeds the %dx%d original (clamped)" % (plate["crop"], W, H))
        sx, sy = got[0] / W, got[1] / H  # scale the box to the downloaded copy
        box = (max(0, round(l * sx)), max(0, round(t * sy)),
               min(got[0], round(r * sx)), min(got[1], round(b * sy)))
        im = im.crop(box)
        clong = max(r - l, b - t)
        if step is not None and max(im.size) < min(MAIN_MAX, clong) - 2:
            return None, "thumbnail too small for crop"  # caller retries with the original
    im, trimmed = trim_borders(im)
    main = im if max(im.size) <= MAIN_MAX else im.resize(fit(im.size, MAIN_MAX), Image.LANCZOS,
                                                         reducing_gap=3.0)
    if plate.get("heal"):
        main = heal(main, plate["heal"])
    main = neutral_tone(main)
    small = main if max(main.size) <= SMALL_MAX else main.resize(fit(main.size, SMALL_MAX),
                                                                 Image.LANCZOS)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    save_jpeg(main, OUT_DIR / (plate["id"] + ".jpg"), MAIN_Q)
    save_jpeg(small, OUT_DIR / (plate["id"] + "-s.jpg"), SMALL_Q)
    return {
        "w": main.size[0], "h": main.size[1], "sw": small.size[0], "sh": small.size[1],
        "how": how, "fmt": fmt, "src_bytes": len(data), "trimmed": trimmed, "warn": warn,
    }, None


def fetch_all(plates, net, args, prev_files):
    todo = []
    for p in plates:
        main, small = OUT_DIR / (p["id"] + ".jpg"), OUT_DIR / (p["id"] + "-s.jpg")
        present = main.exists() and small.exists()
        changed = p["id"] in prev_files and prev_files[p["id"]] != p["commons_file"]
        if args.force or changed or not present:
            todo.append(p)
    present_n = len(plates) - len(todo)
    later = 0
    if args.limit and len(todo) > args.limit:
        later = len(todo) - args.limit
        todo = todo[:args.limit]
    log("%d plates: %d to fetch, %d already present%s" % (
        len(plates), len(todo), present_n, (", %d left for a later run" % later) if later else ""))
    if not todo:
        return [], {}

    names = sorted({p["commons_file"] for p in todo})
    log("Querying Commons imageinfo for %d files…" % len(names))
    infos = net.imageinfo(names, THUMB_STEPS[0])
    for info in infos.values():
        if info:
            info["_thumbs"] = {THUMB_STEPS[0]: info.get("thumburl")}
    # plates whose crop needs a bigger thumbnail
    need_big = sorted({p["commons_file"] for p in todo
                       if infos.get(p["commons_file"]) and plan(p, infos[p["commons_file"]]) == 3840})
    if need_big:
        log("Querying %d files again for %dpx thumbnails (crops)…" % (len(need_big), THUMB_STEPS[1]))
        big = net.imageinfo(need_big, THUMB_STEPS[1])
        for n, bi in big.items():
            if bi and infos.get(n):
                infos[n]["_thumbs"][THUMB_STEPS[1]] = bi.get("thumburl")

    failures = {}
    done = []
    for i, p in enumerate(todo, 1):
        info = infos.get(p["commons_file"])
        tag = "[%3d/%d] %s" % (i, len(todo), p["id"])
        if not info:
            failures[p["id"]] = "file not found on Commons: %s" % p["commons_file"]
            log("%s  FAILED  %s" % (tag, failures[p["id"]]))
            continue
        try:
            res, why = process(p, info, net)
            if res is None:
                log("%s  %s, fetching the original" % (tag, why))
                res, why = process(p, info, net, force_original=True)
            if res is None:
                raise RuntimeError(why)
        except Exception as e:  # noqa: BLE001 - reported and retried
            failures[p["id"]] = "%s: %s" % (type(e).__name__, e)
            log("%s  FAILED  %s" % (tag, failures[p["id"]]))
            continue
        extra = ""
        if any(res["trimmed"]):
            extra += "  trimmed l/t/r/b %s" % res["trimmed"]
        if res["warn"]:
            extra += "  WARN " + "; ".join(res["warn"])
        log("%s  %-24s %4dx%-4d s %3dx%-3d  src %s %5.1f MB%s%s" % (
            tag, res["how"][:24], res["w"], res["h"], res["sw"], res["sh"], res["fmt"],
            res["src_bytes"] / 1e6, "  crop" if p["crop"] else "", extra))
        done.append((p, res))
    return done, failures


# ------------------------------------------------------------------------------ art.json
def write_art_json(plates):
    rows, missing = [], []
    for p in plates:
        main, small = OUT_DIR / (p["id"] + ".jpg"), OUT_DIR / (p["id"] + "-s.jpg")
        if not (main.exists() and small.exists()):
            missing.append(p["id"])
            continue
        with Image.open(main) as a:
            w, h = a.size
        with Image.open(small) as b:
            sw, sh = b.size
        row = {
            "id": p["id"], "title": p["title"], "scene": p["scene"], "ref": p["ref"],
            "also": p["also"], "w": w, "h": h, "sw": sw, "sh": sh,
            "page": p["commons_page"], "file": p["commons_file"],
        }
        if max(w, h) < LOWRES_BELOW:
            row["lowres"] = True  # only a small scan exists: show it no larger than ~1:1
        rows.append(row)
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    text = '{"credit":%s,\n"plates":[\n%s\n]}\n' % (json.dumps(CREDIT, ensure_ascii=False), body)
    write_atomic(ART_JSON, text)
    return len(rows), missing


# ------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--force", action="store_true", help="re-fetch even if images exist")
    ap.add_argument("--only", help="comma-separated plate ids (dore-015) or idx numbers")
    ap.add_argument("--limit", type=int, default=0, help="fetch at most N plates this run")
    ap.add_argument("--recurate", action="store_true",
                    help="rebuild src/art/dore.json from the raw inputs and overrides")
    ap.add_argument("--no-fetch", action="store_true", help="only write the JSON files")
    ap.add_argument("--cache", metavar="DIR",
                    help="keep downloaded source images in DIR and reuse them on later runs")
    args = ap.parse_args()

    if DORE_JSON.exists() and not args.recurate:
        plates = load_json(DORE_JSON)
        log("Loaded %d curated plates from %s" % (len(plates), DORE_JSON.relative_to(ROOT)))
    else:
        plates = curate()
        problems = validate(plates)
        if problems:
            log("Curation problems:\n  " + "\n  ".join(problems))
            sys.exit(1)
        write_atomic(DORE_JSON, dump_dore(plates))
        log("Wrote %d curated plates to %s (overrides applied: %d)" % (
            len(plates), DORE_JSON.relative_to(ROOT), len(OVERRIDES)))
    problems = validate(plates)
    if problems:
        log("Validation problems in dore.json:\n  " + "\n  ".join(problems))
        sys.exit(1)

    selected = plates
    if args.only:
        want = set()
        for tok in args.only.split(","):
            tok = tok.strip()
            want.add(tok if tok.startswith("dore-") else plate_id(int(tok)))
        selected = [p for p in plates if p["id"] in want]
        if not args.force:
            args.force = True  # --only means "redo these"

    prev_files = {}
    if ART_JSON.exists():
        try:
            prev_files = {r["id"]: r["file"] for r in load_json(ART_JSON)["plates"]}
        except Exception:
            prev_files = {}

    net = Net(args.cache)
    t0 = time.time()
    failures = {}
    if not args.no_fetch:
        done, failures = fetch_all(selected, net, args, prev_files)
        if failures:
            log("\nRetrying %d failed plate(s) once…" % len(failures))
            retry = [p for p in selected if p["id"] in failures]
            args2 = argparse.Namespace(**vars(args))
            args2.force, args2.limit = True, 0
            done2, failures = fetch_all(retry, net, args2, prev_files)
            done += done2

    n, missing = write_art_json(plates)
    total = sum((OUT_DIR / (p["id"] + s)).stat().st_size for p in plates
                for s in (".jpg", "-s.jpg") if (OUT_DIR / (p["id"] + s)).exists())
    log("\nSummary")
    log("  requests this run: %d, downloaded %.1f MB in %.0fs" % (
        net.requests, net.bytes / 1e6, time.time() - t0))
    log("  art.json: %d plates, images on disk: %.1f MB" % (n, total / 1e6))
    if missing:
        log("  missing images (%d): %s%s" % (len(missing), ", ".join(missing[:12]),
                                              " …" if len(missing) > 12 else ""))
    ids = {p["id"] for p in plates}
    stray = sorted(f.name for f in OUT_DIR.glob("*.jpg")
                   if (f.stem[:-2] if f.stem.endswith("-s") else f.stem) not in ids)
    if stray:
        log("  images of plates no longer curated (safe to remove): %s" % ", ".join(stray))
    if failures:
        log("  FAILURES (%d):" % len(failures))
        for k, v in failures.items():
            log("    %s  %s" % (k, v))
        sys.exit(2)



if __name__ == "__main__":
    main()
