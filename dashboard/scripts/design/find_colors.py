import os
import re

for root, _, files in os.walk("src"):
    for f in files:
        if f.endswith(".tsx") or f.endswith(".ts"):
            path = os.path.join(root, f)
            with open(path, "r") as file:
                try:
                    content = file.read()
                    matches = re.findall(r'(white|#fff|#ffffff|rgba\(255,\s*255,\s*255)', content, re.IGNORECASE)
                    if matches:
                        print(f"{path}: {len(matches)} matches")
                except:
                    pass
