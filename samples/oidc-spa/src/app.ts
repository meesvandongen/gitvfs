import { GitFS } from 'git-fs'
import { github } from 'git-fs/providers/github'
import { gitlab } from 'git-fs/providers/gitlab'
import type { Provider } from './repos'

interface GitHubRepoConfig {
  owner: string
  repo: string
  branch: string
}

interface GitLabRepoConfig {
  projectId: string | number
  branch: string
  name: string
  apiUrl?: string
}

type RepoConfig = GitHubRepoConfig | GitLabRepoConfig

export function renderApp(
  appEl: HTMLElement,
  accessToken: string,
  provider: Provider,
  repoConfig: RepoConfig,
  onBack: () => void,
  onLogout: () => void,
) {
  let fs: GitFS
  let repoDisplayName: string
  let branch: string

  if (provider === 'github') {
    const config = repoConfig as GitHubRepoConfig
    repoDisplayName = `${config.owner}/${config.repo}`
    branch = config.branch
    fs = new GitFS({
      provider: github({ token: accessToken, owner: config.owner, repo: config.repo }),
      branch,
    })
  } else {
    const config = repoConfig as GitLabRepoConfig
    repoDisplayName = config.name
    branch = config.branch
    fs = new GitFS({
      provider: gitlab({ token: accessToken, projectId: config.projectId, apiUrl: config.apiUrl }),
      branch,
    })
  }

  // State
  let currentPath = ''
  let selectedFile: string | null = null
  let fileContent = ''
  let isDirty = false

  appEl.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div class="app-header-left">
          <button id="back-btn" class="btn btn-ghost btn-sm">← Repositories</button>
          <span class="header-separator"></span>
          <span class="repo-name">${repoDisplayName}</span>
          <span class="branch-badge">${branch}</span>
        </div>
        <div class="app-header-right">
          <button id="logout-btn" class="btn btn-ghost btn-sm">Sign Out</button>
        </div>
      </header>

      <div class="app-body">
        <aside class="sidebar">
          <div class="sidebar-header">
            <span id="breadcrumb" class="breadcrumb">/ (root)</span>
          </div>
          <div id="file-list" class="file-list">
            <div class="loading-inline">
              <div class="spinner spinner-sm"></div>
              Loading...
            </div>
          </div>
        </aside>

        <main class="editor-pane">
          <div id="editor-empty" class="editor-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <path d="M9 12h6M9 16h6M9 8h6M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
            <p>Select a file to view its contents</p>
          </div>
          <div id="editor-content" class="editor-content" style="display:none">
            <div class="editor-toolbar">
              <span id="file-path-label" class="file-path-label"></span>
              <div class="editor-actions">
                <button id="save-btn" class="btn btn-primary btn-sm" disabled>Save &amp; Commit</button>
              </div>
            </div>
            <textarea id="file-editor" class="file-editor" spellcheck="false"></textarea>
          </div>
          <div id="editor-error" class="editor-error" style="display:none">
            <p id="editor-error-msg"></p>
          </div>
        </main>
      </div>

      <div id="toast" class="toast" style="display:none"></div>
    </div>
  `

  document.getElementById('back-btn')!.addEventListener('click', onBack)
  document.getElementById('logout-btn')!.addEventListener('click', onLogout)

  const fileEditor = document.getElementById('file-editor') as HTMLTextAreaElement
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement

  fileEditor.addEventListener('input', () => {
    fileContent = fileEditor.value
    isDirty = fileContent !== fileEditor.dataset.original
    saveBtn.disabled = !isDirty
  })

  saveBtn.addEventListener('click', async () => {
    if (!selectedFile || !isDirty) return
    saveBtn.disabled = true
    saveBtn.textContent = 'Saving...'

    try {
      fs.writeFile(selectedFile, fileContent)
      await fs.commit(`Update ${selectedFile}`)
      fileEditor.dataset.original = fileContent
      isDirty = false
      showToast('Changes committed successfully', 'success')
    } catch (err) {
      showToast(`Commit failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
      saveBtn.disabled = false
    } finally {
      saveBtn.textContent = 'Save & Commit'
      saveBtn.disabled = !isDirty
    }
  })

  function showToast(message: string, type: 'success' | 'error') {
    const toast = document.getElementById('toast')!
    toast.textContent = message
    toast.className = `toast toast-${type}`
    toast.style.display = 'block'
    setTimeout(() => {
      toast.style.display = 'none'
    }, 3000)
  }

  async function loadDirectory(path: string) {
    currentPath = path
    selectedFile = null
    showEditorEmpty()

    const breadcrumb = document.getElementById('breadcrumb')!
    breadcrumb.textContent = path ? `/ ${path}` : '/ (root)'

    const fileList = document.getElementById('file-list')!
    fileList.innerHTML = `
      <div class="loading-inline">
        <div class="spinner spinner-sm"></div>
        Loading...
      </div>
    `

    try {
      const entries = await fs.readdir(path)
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'tree' ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      const items: string[] = []

      if (path) {
        const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        items.push(`
          <div class="file-item file-item-dir" data-path="${parentPath}" data-type="tree">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 19l-7-7 7-7"/>
            </svg>
            ..
          </div>
        `)
      }

      for (const entry of entries) {
        const entryPath = path ? `${path}/${entry.name}` : entry.name
        const isDir = entry.type === 'tree'
        items.push(`
          <div class="file-item ${isDir ? 'file-item-dir' : 'file-item-file'}"
               data-path="${entryPath}"
               data-type="${entry.type}">
            ${isDir
              ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="icon-dir">
                   <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
                 </svg>`
              : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="icon-file">
                   <path d="M9 12h6M9 16h3M13 4H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V9l-6-5z"/>
                   <path d="M13 4v5h5"/>
                 </svg>`
            }
            <span>${entry.name}</span>
          </div>
        `)
      }

      if (items.length === 0 && !path) {
        fileList.innerHTML = '<div class="file-list-empty">Repository is empty</div>'
      } else {
        fileList.innerHTML = items.join('')
        fileList.querySelectorAll('.file-item').forEach((el) => {
          el.addEventListener('click', () => {
            const itemPath = (el as HTMLElement).dataset.path!
            const itemType = (el as HTMLElement).dataset.type!
            if (itemType === 'tree') {
              loadDirectory(itemPath)
            } else {
              loadFile(itemPath)
            }
          })
        })
      }
    } catch (err) {
      fileList.innerHTML = `<div class="file-list-error">Error: ${err instanceof Error ? err.message : String(err)}</div>`
    }
  }

  async function loadFile(path: string) {
    selectedFile = path
    isDirty = false

    document.querySelectorAll('.file-item').forEach((el) => {
      el.classList.toggle('file-item-active', (el as HTMLElement).dataset.path === path)
    })

    const editorEmpty = document.getElementById('editor-empty')!
    const editorContent = document.getElementById('editor-content')!
    const editorError = document.getElementById('editor-error')!
    const filePathLabel = document.getElementById('file-path-label')!

    editorEmpty.style.display = 'none'
    editorError.style.display = 'none'
    editorContent.style.display = 'flex'
    filePathLabel.textContent = path
    fileEditor.value = 'Loading...'
    fileEditor.disabled = true
    saveBtn.disabled = true

    try {
      const content = (await fs.readFile(path, { encoding: 'utf-8' })) as string
      fileEditor.value = content
      fileEditor.dataset.original = content
      fileContent = content
      fileEditor.disabled = false
    } catch (err) {
      editorContent.style.display = 'none'
      editorError.style.display = 'flex'
      document.getElementById('editor-error-msg')!.textContent =
        `Could not load file: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  function showEditorEmpty() {
    document.getElementById('editor-empty')!.style.display = 'flex'
    document.getElementById('editor-content')!.style.display = 'none'
    document.getElementById('editor-error')!.style.display = 'none'
  }

  // Suppress unused variable warning – currentPath is read by loadDirectory closures
  void currentPath

  loadDirectory('')
}
