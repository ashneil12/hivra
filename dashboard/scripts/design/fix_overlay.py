import os
import re

for root, _, files in os.walk("src"):
    for f in files:
        if f.endswith(".tsx") or f.endswith(".ts"):
            path = os.path.join(root, f)
            try:
                with open(path, "r") as file:
                    content = file.read()
                
                # Replace rgba(255, 255, 255, X) with var(--overlay-bg)
                new_content = re.sub(r'rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*[0-9.]+\s*\)', 'var(--overlay-bg)', content)
                
                if new_content != content:
                    with open(path, "w") as file:
                        file.write(new_content)
            except Exception as e:
                pass
