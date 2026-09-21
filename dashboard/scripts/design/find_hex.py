import os, re
pattern = re.compile(r'#[e-fE-F]{3}(?:[e-fE-F]{3})?\b')

for root, _, files in os.walk("src"):
    for f in files:
        if f.endswith(".tsx") or f.endswith(".ts"):
            path = os.path.join(root, f)
            try:
                with open(path) as file:
                    content = file.read()
                    matches = pattern.findall(content)
                    if matches:
                        print(f"{path}: {list(set(matches))}")
            except: pass
