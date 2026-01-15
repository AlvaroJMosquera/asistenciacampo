import { useRef, useCallback, useState } from 'react';
import imageCompression from 'browser-image-compression';

interface CameraState {
  isCapturing: boolean;
  error: string | null;
}

export function useCamera() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<CameraState>({
    isCapturing: false,
    error: null,
  });

  const capturePhoto = useCallback((): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      // Create input element if not exists
      if (!inputRef.current) {
        inputRef.current = document.createElement('input');
        inputRef.current.type = 'file';
        inputRef.current.accept = 'image/*';
        inputRef.current.capture = 'environment'; // Use back camera
        inputRef.current.style.display = 'none';
        document.body.appendChild(inputRef.current);
      }

      setState({ isCapturing: true, error: null });

      const input = inputRef.current;

      const cleanup = () => {
        input.onchange = null;
        input.value = '';
      };

      input.onchange = async (e) => {
        const target = e.target as HTMLInputElement;
        const file = target.files?.[0];

        if (!file) {
          cleanup();
          setState({ isCapturing: false, error: 'No se capturó ninguna foto' });
          reject(new Error('No se capturó ninguna foto'));
          return;
        }

        try {
          // Compress the image for field use (max 500KB)
          const compressedFile = await imageCompression(file, {
            maxSizeMB: 0.5,
            maxWidthOrHeight: 1280,
            useWebWorker: true,
          });

          cleanup();
          setState({ isCapturing: false, error: null });
          resolve(compressedFile);
        } catch (error) {
          cleanup();
          const errorMessage = 'Error procesando la foto';
          setState({ isCapturing: false, error: errorMessage });
          reject(new Error(errorMessage));
        }
      };

      // Trigger file picker/camera
      input.click();

      // Handle case where user cancels
      const handleFocus = () => {
        setTimeout(() => {
          if (input.value === '') {
            cleanup();
            setState({ isCapturing: false, error: null });
            reject(new Error('Captura cancelada'));
          }
          window.removeEventListener('focus', handleFocus);
        }, 500);
      };

      window.addEventListener('focus', handleFocus);
    });
  }, []);

  return {
    ...state,
    capturePhoto,
  };
}
