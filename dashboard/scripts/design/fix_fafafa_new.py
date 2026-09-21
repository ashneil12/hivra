import os, re

for root, _, files in os.walk("src"):
    for f in files:
        if f.endswith(".tsx") or f.endswith(".ts"):
            path = os.path.join(root, f)
            try:
                with open(path, "r") as file:
                    content = file.read()
                
                # Replace #fafafa
                new_content = re.sub(r'#fafafa\b', 'var(--bg-elevated)', content, flags=re.IGNORECASE)
                
                if new_content != content:
                    with open(path, "w") as file:
                        file.write(new_content)
                    print(f"Fixed {path}")
            except Exception as e:
                pass
