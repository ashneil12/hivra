import re

with open("src/app/globals.css", "r") as f:
    text = f.read()

# Replace background: white
text = re.sub(r'background:\s*white\s*(!important)?\s*;', lambda m: f'background: var(--bg-surface){" !important" if m.group(1) else ""};', text)

# Replace background-color: white
text = re.sub(r'background-color:\s*white\s*(!important)?\s*;', lambda m: f'background-color: var(--bg-surface){" !important" if m.group(1) else ""};', text)

# Replace color: white meant for ink-black background
text = re.sub(r'color:\s*white\s*(!important)?\s*;', lambda m: f'color: var(--bg-surface){" !important" if m.group(1) else ""};', text)

with open("src/app/globals.css", "w") as f:
    f.write(text)
