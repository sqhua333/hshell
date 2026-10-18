import { useState, type ReactElement } from 'react'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Modal } from './Modal'

export function FolderDialog(): ReactElement | null {
  const open = useApp((state) => state.folderDialogOpen)
  const setOpen = useApp((state) => state.setFolderDialogOpen)
  const createFolder = useApp((state) => state.createFolder)
  const folderParentId = useApp((state) => state.folderParentId)
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  if (!open) return null

  const submit = async (): Promise<void> => {
    const value = name.trim()
    if (!value) {
      setError(tr('请输入分组名称', 'Please enter a folder name'))
      return
    }
    try {
      await createFolder(value, folderParentId)
      setName('')
      setError('')
      setOpen(false)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Modal
      title={tr('新建分组', 'New folder')}
      width={420}
      onClose={() => setOpen(false)}
      footer={
        <>
          {error ? <div className="form-error">{error}</div> : <div />}
          <div className="modal-actions">
            <button className="btn" onClick={() => setOpen(false)}>
              {tr('取消', 'Cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => void submit()}>
              {tr('创建', 'Create')}
            </button>
          </div>
        </>
      }
    >
      <label className="field">
        <span>{tr('分组名称', 'Folder name')}</span>
        <input
          className="input"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          placeholder={tr('例如：生产环境', 'e.g. Production')}
        />
      </label>
    </Modal>
  )
}
