import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';

const CameraWrap = styled.div`
  width: 100%;
  max-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`;

const ToggleButton = styled.button`
  border: 1px solid rgba(95, 146, 255, 0.5);
  background: ${({ $active }) => ($active ? 'rgba(38, 127, 255, 0.22)' : 'rgba(11, 22, 46, 0.72)')};
  color: ${({ $active }) => ($active ? '#bfe1ff' : '#8ca5cc')};
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
`;

const Preview = styled.video`
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  background: #0c1327;
  object-fit: cover;
  border: 1px solid rgba(110, 132, 177, 0.35);
`;

const MetaRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`;

const StateChip = styled.span`
  font-size: 10px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  font-weight: 700;
  color: ${({ $ok }) => ($ok ? '#34d399' : '#fca5a5')};
`;

const Note = styled.span`
  font-size: 10px;
  color: #8aa6d9;
`;

const OffNote = styled.div`
  font-size: 11px;
  color: #8aa6d9;
  text-align: center;
  border: 1px dashed rgba(116, 146, 202, 0.35);
  border-radius: 10px;
  padding: 10px;
  background: rgba(10, 18, 38, 0.5);
`;

const HiddenCanvas = styled.canvas`
  display: none;
`;

const LiveVisionCamera = ({ onCaptureReady }) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [isEnabled, setIsEnabled] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [errorText, setErrorText] = useState('');

  const captureFrame = useCallback(() => {
    if (!isEnabled) return null;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return null;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    return dataUrl.split(',')[1] || null;
  }, [isEnabled]);

  useEffect(() => {
    onCaptureReady?.(captureFrame);
  }, [captureFrame, onCaptureReady]);

  useEffect(() => {
    if (!isEnabled) {
      setIsReady(false);
      setErrorText('Vision disabled by user');
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      return;
    }

    let isCancelled = false;

    const start = async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setErrorText('Webcam API unavailable');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          },
          audio: false,
        });

        if (isCancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        setIsReady(true);
        setErrorText('');
      } catch (err) {
        setIsReady(false);
        setErrorText(err?.name === 'NotAllowedError' ? 'Camera permission denied' : 'Unable to start camera');
      }
    };

    start();

    return () => {
      isCancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, [isEnabled]);

  return (
    <CameraWrap>
      <Toolbar>
        <StateChip $ok={isReady && isEnabled}>{isReady && isEnabled ? 'Vision Live' : 'Vision Off'}</StateChip>
        <ToggleButton
          type="button"
          onClick={() => setIsEnabled((prev) => !prev)}
          $active={isEnabled}
        >
          {isEnabled ? 'Disable Vision' : 'Enable Vision'}
        </ToggleButton>
      </Toolbar>

      {isEnabled ? (
        <>
          <Preview ref={videoRef} autoPlay muted playsInline />
          <MetaRow>
            <Note>{errorText && !isReady ? errorText : 'Frame auto-captured on voice submit'}</Note>
          </MetaRow>
        </>
      ) : (
        <OffNote>Vision is off. Enable to attach live camera frames to voice commands.</OffNote>
      )}

      <HiddenCanvas ref={canvasRef} />
    </CameraWrap>
  );
};

export default LiveVisionCamera;
