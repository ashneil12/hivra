"""Pinned native patch contract and regression checks; no guest mutation."""
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
PATCH = ROOT / '0001-virtio-cursor-hotspot.patch'


def patched_hunks():
    result = []
    for hunk in PATCH.read_text().split('@@')[2::2]:
        # Stop at the next file header.
        lines = hunk.split('diff --git')[0].splitlines()
        result.append('\n'.join(line[1:] for line in lines
                                if line.startswith((' ', '+')) and not line.startswith('+++')))
    return result


class RepairTests(unittest.TestCase):
    def test_package_pins_patch_and_native_abi_without_installing(self):
        recipe = (ROOT / 'PKGBUILD').read_text()
        self.assertIn(hashlib.sha256(PATCH.read_bytes()).hexdigest(), recipe)
        self.assertIn('#commit=a79fb21b2e2a82dd061a6d071802bcf38bd5c383', recipe)
        self.assertIn("pkgname=aquamarine", recipe)
        self.assertIn("pkgrel=2.1", recipe)
        self.assertNotIn('pacman -', recipe)

    def test_atomic_capability_is_opt_in_and_failure_preserves_atomic(self):
        source = patched_hunks()[0]
        self.assertLess(source.index('DRM_CLIENT_CAP_CURSOR_PLANE_HOTSPOT'), source.index('atomic                       = true'))
        self.assertRegex(source, r'if \(drmSetClientCap\(gpu->fd, DRM_CLIENT_CAP_CURSOR_PLANE_HOTSPOT, 1\)\)\s*backend->log')
        self.assertNotIn('return false', source)
        self.assertNotIn('AQ_NO_ATOMIC', source)

    def test_native_cursor_hotspot_properties_guard_missing_physical_properties(self):
        source = patched_hunks()[1]
        # These are executable checks of the actual patched hotspot statements,
        # not a surrogate Python implementation of the cursor algorithm.
        body = source[source.index('const auto& props'):source.index('\n                }')]
        native = r'''
#include <cstdint>
#include <vector>
#include <cassert>
struct Props { uint32_t hotspot_x=0, hotspot_y=0; };
struct Cursor { uint32_t id=36; struct { Props values; } props; };
struct Output { struct { double x=4,y=2; } cursorHotspot; };
struct Crtc { Cursor* cursor; };
struct Connector { Crtc* crtc; Output* output; };
struct Call { uint32_t id,prop; uint64_t value; };
std::vector<Call> calls;
void add(uint32_t id,uint32_t prop,uint64_t value) { calls.push_back({id,prop,value}); }
void update(Connector* connector) { BODY }
int main() {
 Cursor cursor; Output output; Crtc crtc{&cursor}; Connector connector{&crtc,&output};
 update(&connector); assert(calls.empty()); // physical DRM, absent props
 cursor.props.values={37,38}; update(&connector);
 assert(calls.size()==2 && calls[0].id==36 && calls[0].prop==37 && calls[0].value==4);
 assert(calls[1].prop==38 && calls[1].value==2); // virtio hotspot in image pixels
 calls.clear(); cursor.props.values={37,0}; update(&connector);
 assert(calls.size()==1 && calls[0].prop==37); // properties guarded separately
}
'''.replace('BODY', body)
        with tempfile.TemporaryDirectory(prefix='aquamarine-hotspot-test-') as temporary:
            path = Path(temporary)
            (path / 'test.cpp').write_text(native)
            subprocess.run(['c++', '-std=c++17', str(path / 'test.cpp'), '-o', str(path / 'test')], check=True, capture_output=True)
            subprocess.run([str(path / 'test')], check=True)


if __name__ == '__main__':
    unittest.main()
