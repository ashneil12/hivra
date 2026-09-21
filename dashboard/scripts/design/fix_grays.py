import os, re

for root, _, files in os.walk("src"):
    for f in files:
        if f.endswith(".tsx") or f.endswith(".ts"):
            path = os.path.join(root, f)
            with open(path, "r") as file:
                content = file.read()
            
            # replace '#ccc' with 'var(--border-subtle)'
            new_content = re.sub(r'#ccc\b', 'var(--border-subtle)', content, flags=re.IGNORECASE)
            # replace '#e5e5e5' with 'var(--border-subtle)'
            new_content = re.sub(r'#e5e5e5\b', 'var(--border-subtle)', new_content, flags=re.IGNORECASE)
            # replace '#faf9f6' with 'var(--bg-elevated)'
            new_content = re.sub(r'#faf9f6\b', 'var(--bg-elevated)', new_content, flags=re.IGNORECASE)
            
            if new_content != content:
                print(f"Fixed {path}")
                with open(path, "w") as file:
                    file.write(new_content)
