import { useEffect, useState } from 'react'
import { HomePage } from './app/HomePage'
import { EditorPage } from './app/EditorPage'
import { getStorageInfo } from './control'
import './app/app-shell.css'

type Route = { type: 'home' } | { type: 'editor'; docId: string }

// This is the app shell: it owns navigation between its own pages (Home,
// Editor) and wires each page to persistence. The reusable editor itself
// (src/view/Editor.tsx) has no idea any of this exists -- it just takes
// markdown in and reports changes out, so it can be dropped into a different
// app with a different shell around it.
function App() {
  const [route, setRoute] = useState<Route>({ type: 'home' })
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
      {route.type === 'editor' ? (
        <EditorPage docId={route.docId} onBack={() => setRoute({ type: 'home' })} />
      ) : (
        <HomePage onOpenDoc={(docId) => setRoute({ type: 'editor', docId })} />
      )}
    </>
  )
}

export default App
