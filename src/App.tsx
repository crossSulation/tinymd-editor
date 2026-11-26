import { useEffect, useState } from 'react'
import { AppShell } from './app/AppShell'
import { getStorageInfo } from './control'
import './app/app-shell.css'

// This is the app shell's own entry point: it owns the one piece of global
// chrome above everything else (the storage-persistence warning) and
// otherwise just renders AppShell, which owns the persistent sidebar +
// editor-pane layout (see UX_PLAN.md Phase 10). The reusable editor itself
// (src/view/Editor.tsx) has no idea any of this exists -- it just takes
// markdown in and reports changes out, so it can be dropped into a different
// app with a different shell around it.
function App() {
  const [persistent, setPersistent] = useState<boolean | null>(null)

  useEffect(() => {
    void getStorageInfo().then((info) => setPersistent(info.persistent))
  }, [])

  return (
    <>
      {persistent === false && (
        <div className="storage-warning" role="alert">
          Persistent storage (OPFS) isn't available in this browser/context -- documents will be
          lost when this tab is closed or reloaded. Check the browser console for details.
        </div>
      )}
      <AppShell />
    </>
  )
}

export default App
