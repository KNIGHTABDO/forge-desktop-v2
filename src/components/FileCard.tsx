// src/components/FileCard.tsx
import React from 'react';

export type FileMetadata = {
  name: string;
  type: 'image' | 'code' | 'pdf' | 'other';
  preview: string;
  size: number;
};

export const FileCard = ({ file }: { file: FileMetadata }) => {
  return (
    <div className="file-card">
      <div className="preview">{file.type === 'image' ? <img src={file.preview} alt={file.name} /> : <pre>{file.preview.slice(0, 50)}</pre>}</div>
      <div className="info">
        <p>{file.name}</p>
        <span>{file.size} bytes</span>
      </div>
    </div>
  );
};
