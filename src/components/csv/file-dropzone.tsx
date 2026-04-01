"use client";

import { useCallback, useState, useRef } from "react";
import { cn } from "@/lib/utils";

interface FileDropzoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  label: string;
  description: string;
}

export function FileDropzone({
  onFilesSelected,
  accept = ".csv",
  label,
  description,
}: FileDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.name.endsWith(".csv")
      );
      if (files.length > 0) onFilesSelected(files);
    },
    [onFilesSelected]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) onFilesSelected(files);
      if (inputRef.current) inputRef.current.value = "";
    },
    [onFilesSelected]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
        isDragOver
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-primary/50"
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        onChange={handleFileChange}
        className="hidden"
      />
      <div className="text-4xl mb-2">📁</div>
      <p className="font-medium">{label}</p>
      <p className="text-sm text-muted-foreground mt-1">{description}</p>
    </div>
  );
}
