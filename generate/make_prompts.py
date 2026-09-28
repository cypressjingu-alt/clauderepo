"""Write a batch of varied ACE-Step prompts for generate/music.py (stdlib only, deterministic).

  python generate/make_prompts.py <jazz_count> <lofi_count> <seed> > batch.json

Each prompt gets a unique evocative title, a genre folder (music/<genre>/ai-acestep/),
a style, mood and setting, a tempo inside that style's range, a length, and a seed.
Use a different <seed> for the next batch: titles already on disk are skipped by music.py.
"""
import json
import random
import sys

STYLES = {
    "jazz": [
        ("smooth lounge jazz, soft piano trio, upright bass, brushed drums", (80, 110)),
        ("bossa nova, nylon string guitar, soft brushes, mellow flute", (110, 135)),
        ("late night jazz ballad, solo piano, spacious", (58, 76)),
        ("cool jazz quartet, muted trumpet, piano, upright bass, brushed snare", (90, 130)),
        ("hotel lobby jazz, vibraphone, piano, soft upright bass", (85, 115)),
        ("piano bar jazz, warm grand piano, light swing, walking bass", (100, 140)),
        ("jazz guitar trio, hollow body guitar, hammond organ, soft drums", (85, 120)),
        ("saxophone lounge, breathy tenor saxophone, rhodes piano, soft groove", (75, 100)),
    ],
    "lofi": [
        ("lofi hip hop, dusty jazz chords, mellow rhodes piano, laid-back boom bap drums, vinyl crackle", (70, 90)),
        ("chill lofi jazz guitar, soft kick and snare, warm bass", (75, 92)),
        ("lofi piano, tape saturation, gentle drums, soft pads", (65, 85)),
        ("jazzy lofi beat, muted trumpet, swung drums, upright bass", (80, 95)),
        ("ambient lofi, warm synth pads, soft rhodes, slow drums", (60, 78)),
    ],
}
MOODS = ["warm, relaxed", "elegant, calm", "romantic, gentle", "cozy, intimate", "mellow, late night", "bright, easy",
         "nostalgic, soft", "dreamy, peaceful"]
SETTINGS = ["elegant hotel lobby", "cozy cafe", "rainy evening", "candlelit restaurant", "quiet bookstore", "city at night",
            "sunday morning", "autumn afternoon", "snowy window", "rooftop at dusk"]
ADJ = ["Velvet", "Amber", "Midnight", "Golden", "Quiet", "Silver", "Rainy", "Soft", "Late", "Candlelit", "Hazy", "Blue",
       "Warm", "Lazy", "Gentle", "Faded", "Copper", "Misty", "Moonlit", "Slow", "Crimson", "Dusty", "Early", "Paper"]
NOUN = ["Hours", "Lobby", "Streets", "Letters", "Window", "Evening", "Corner", "Avenue", "Terrace", "Lanterns", "Harbor",
        "Balcony", "Carousel", "Pages", "Umbrella", "Parlor", "Rooftops", "Station", "Garden", "Stairs", "Ribbon", "Tides",
        "Mornings", "Porch"]


def main(jazz, lofi, seed):
    rng = random.Random(seed)
    titles = [f"{a} {n}" for a in ADJ for n in NOUN]
    rng.shuffle(titles)
    out = []
    for genre, count in (("jazz", jazz), ("lofi", lofi)):
        for _ in range(count):
            style, (lo, hi) = rng.choice(STYLES[genre])
            out.append({
                "name": titles.pop(),
                "dir": f"{genre}/ai-acestep",
                "caption": f"{style}, {rng.choice(MOODS)}, {rng.choice(SETTINGS)}, instrumental",
                "bpm": rng.randint(lo, hi),
                "duration": rng.choice([180, 210, 240, 270]),
                "seed": rng.randint(1, 2**31 - 1),
            })
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main(int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]))
