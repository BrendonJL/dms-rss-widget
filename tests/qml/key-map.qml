import QtQml
import "KeyMap.js" as KeyMap

QtObject {
    Component.onCompleted: {
        var code = 30; // 30 = never got started
        try {
            function state(overrides) {
                var s = { index: -1, count: 5, searchActive: false, hasSelection: false, pending: null, pendingAt: 0, now: 0 };
                for (var k in overrides) s[k] = overrides[k];
                return s;
            }
            function evt(key, modifiers) {
                return { key: key, text: "", modifiers: modifiers || 0 };
            }

            // j at rest moves to 0.
            var r1 = KeyMap.resolveKey(evt(KeyMap.Key_J), state({ index: -1 }));
            code = 31; // 31 = j at rest did not move to 0
            if (r1.action !== "move" || r1.index !== 0) { Qt.exit(code); return; }

            // j clamps at the last index.
            var r2 = KeyMap.resolveKey(evt(KeyMap.Key_J), state({ index: 4, count: 5 }));
            code = 32; // 32 = j did not clamp at the last index
            if (r2.action !== "move" || r2.index !== 4) { Qt.exit(code); return; }

            // g g -> first, within the 800ms window.
            var r3 = KeyMap.resolveKey(evt(KeyMap.Key_G), state({ index: 3, pending: "g", pendingAt: 100, now: 300 }));
            code = 33; // 33 = g g did not move to the first item
            if (r3.action !== "move" || r3.index !== 0) { Qt.exit(code); return; }

            // G (shift) -> last.
            var r4 = KeyMap.resolveKey(evt(KeyMap.Key_G, KeyMap.ShiftModifier), state({ index: 1, count: 5 }));
            code = 34; // 34 = G did not move to the last item
            if (r4.action !== "move" || r4.index !== 4) { Qt.exit(code); return; }

            // Esc layering: search open takes priority over a selection.
            var r5 = KeyMap.resolveKey(evt(KeyMap.Key_Escape), state({ searchActive: true, hasSelection: true, index: 2 }));
            code = 35; // 35 = Esc did not close search first
            if (r5.action !== "closeSearch") { Qt.exit(code); return; }

            // Search focus swallows j.
            var r6 = KeyMap.resolveKey(evt(KeyMap.Key_J), state({ searchActive: true, index: 1 }));
            code = 36; // 36 = j leaked through while search had focus
            if (r6.action !== null) { Qt.exit(code); return; }

            // -1 blocks everything except j.
            var r7 = KeyMap.resolveKey(evt(KeyMap.Key_Return), state({ index: -1 }));
            code = 37; // 37 = Enter fired at rest (index -1)
            if (r7.action !== null) { Qt.exit(code); return; }

            // Empty list never yields an out-of-range index.
            var r8 = KeyMap.resolveKey(evt(KeyMap.Key_G, KeyMap.ShiftModifier), state({ index: -1, count: 0 }));
            code = 38; // 38 = empty-list G produced an out-of-range index
            if (r8.index !== -1) { Qt.exit(code); return; }

            Qt.exit(55); // 55 = everything worked
        } catch (e) {
            Qt.exit(60); // 60 = threw somewhere unexpected
        }
    }
}
