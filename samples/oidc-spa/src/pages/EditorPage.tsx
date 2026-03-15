import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitFS } from 'git-fs'
import { createGitFs, readTextFile, saveFileAndCommit, type RepoSelection } from '../lib/git-data'
import { getStoredProviderToken } from '../lib/provider-config'

interface TreeEntry {
  name: string
  type: 'blob' | 'tree'
}

export function EditorPage() {
  const repoSelection = useSearch({ from: '/editor' }) as RepoSelection
  const navigate = useNavigate({ from: '/editor' })
  const fsRef = useRef<GitFS | null>(null)

  const [isReady, setIsReady] = useState(false)
  const [directoryPath, setDirectoryPath] = useState('')
  const [entries, setEntries] = useState<TreeEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const repoLabel = repoSelection.kind === 'github'
    ? `${repoSelection.owner}/${repoSelection.repo}`
    : repoSelection.name

  const isDirty = fileContent !== originalContent

  useEffect(() => {
    let isCancelled = false

    async function initialize() {
      setIsBusy(true)
      setErrorMessage(null)

      try {
        const token = getStoredProviderToken(repoSelection.kind)

        if (token === null) {
          throw new Error(`No saved ${repoSelection.kind === 'github' ? 'GitHub' : 'GitLab'} token was found.`)
        }

        if (isCancelled) {
          return
        }

        fsRef.current = createGitFs({
          ...repoSelection,
          token,
        })

        setIsReady(true)
        await loadDirectory('')
      } catch (error) {
        if (!isCancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!isCancelled) {
          setIsBusy(false)
        }
      }
    }

    void initialize()

    return () => {
      isCancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoLabel])

  async function loadDirectory(path: string) {
    const fs = fsRef.current

    if (fs === null) {
      return
    }

    setIsBusy(true)
    setErrorMessage(null)
    setDirectoryPath(path)
    setSelectedFile(null)
    setFileContent('')
    setOriginalContent('')

    try {
      const nextEntries = await fs.readdir(path) as TreeEntry[]
      nextEntries.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'tree' ? -1 : 1
        }

        return a.name.localeCompare(b.name)
      })
      setEntries(nextEntries)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function openFile(path: string) {
    const fs = fsRef.current

    if (fs === null) {
      return
    }

    setIsBusy(true)
    setErrorMessage(null)

    try {
      const content = await readTextFile(fs, path)
      setSelectedFile(path)
      setFileContent(content)
      setOriginalContent(content)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function saveFile() {
    const fs = fsRef.current

    if (fs === null || selectedFile === null || !isDirty) {
      return
    }

    setIsSaving(true)
    setStatusMessage(null)
    setErrorMessage(null)

    try {
      await saveFileAndCommit({
        fs,
        path: selectedFile,
        content: fileContent,
      })
      setOriginalContent(fileContent)
      setStatusMessage(`Committed changes to ${selectedFile}`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSaving(false)
    }
  }

  const parentPath = useMemo(() => {
    if (directoryPath === '') {
      return null
    }

    const index = directoryPath.lastIndexOf('/')
    return index === -1 ? '' : directoryPath.slice(0, index)
  }, [directoryPath])

  return (
    <section className="editor-layout">
      <header className="section-heading editor-heading">
        <div>
          <p className="eyebrow">Saved Token</p>
          <h1 className="section-title">{repoLabel}</h1>
          <p className="section-copy">Branch: {repoSelection.branch}</p>
        </div>
        <div className="editor-heading-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate({ to: '/repositories' })}>
            ← Repositories
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!isDirty || isSaving} onClick={() => void saveFile()}>
            {isSaving ? 'Saving…' : 'Save & Commit'}
          </button>
        </div>
      </header>

      {errorMessage ? <div className="callout callout-danger">{errorMessage}</div> : null}
      {statusMessage ? <div className="callout callout-success">{statusMessage}</div> : null}

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-header">
            <span className="breadcrumb">{directoryPath ? `/ ${directoryPath}` : '/ (root)'}</span>
          </div>
          <div className="file-list">
            {isBusy && !isReady ? (
              <div className="loading-inline">
                <div className="spinner spinner-sm"></div>
                Initializing repository…
              </div>
            ) : (
              <>
                {parentPath !== null && (
                  <button type="button" className="file-item file-item-dir" onClick={() => void loadDirectory(parentPath)}>
                    <span>..</span>
                  </button>
                )}
                {entries.map((entry) => {
                  const path = directoryPath ? `${directoryPath}/${entry.name}` : entry.name
                  const isActive = selectedFile === path

                  return (
                    <button
                      key={path}
                      type="button"
                      className={`file-item ${entry.type === 'tree' ? 'file-item-dir' : 'file-item-file'} ${isActive ? 'file-item-active' : ''}`}
                      onClick={() => void (entry.type === 'tree' ? loadDirectory(path) : openFile(path))}
                    >
                      <span>{entry.name}</span>
                    </button>
                  )
                })}
                {entries.length === 0 && !isBusy ? <div className="file-list-empty">No entries found.</div> : null}
              </>
            )}
          </div>
        </aside>

        <main className="editor-pane">
          {selectedFile === null ? (
            <div className="editor-empty">
              <p>Select a file to read or edit its contents.</p>
            </div>
          ) : (
            <div className="editor-content">
              <div className="editor-toolbar">
                <span className="file-path-label">{selectedFile}</span>
                <span className="helper-copy">{isDirty ? 'Unsaved changes' : 'All changes committed'}</span>
              </div>
              <textarea
                className="file-editor"
                spellCheck={false}
                value={fileContent}
                onChange={(event) => setFileContent(event.target.value)}
              />
            </div>
          )}
        </main>
      </div>
    </section>
  )
}
