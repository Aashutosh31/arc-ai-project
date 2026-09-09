import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(2, 2, 10, 0.92);
  backdrop-filter: blur(20px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 24px;
`;

const CloseButton = styled.button`
  position: absolute;
  top: 20px;
  right: 20px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  &:hover { background: rgba(255, 255, 255, 0.1); }
`;

const Title = styled.h2`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: #f1f5f9;
`;

const VideoPreview = styled.video`
  width: min(480px, 100%);
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  background: #0a0a1e;
  object-fit: cover;
  border: 1px solid rgba(0, 255, 255, 0.2);
`;

const Controls = styled.div`
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
`;

const ControlButton = styled.button`
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid ${({ $active }) => ($active ? 'rgba(0, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.15)')};
  background: ${({ $active }) => ($active ? 'rgba(0, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)')};
  color: ${({ $active }) => ($active ? '#00ffff' : '#94a3b8')};
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  &:hover { border-color: rgba(0, 255, 255, 0.3); }
`;

const ToggleButton = styled(ControlButton)`
  padding: 10px 24px;
  font-size: 13px;
  border-color: ${({ $active }) => ($active ? 'rgba(255, 80, 80, 0.5)' : 'rgba(0, 255, 255, 0.4)')};
  background: ${({ $active }) => ($active ? 'rgba(255, 80, 80, 0.15)' : 'rgba(0, 255, 255, 0.1)')};
  color: ${({ $active }) => ($active ? '#ff7070' : '#00ffff')};
`;

const StatusText = styled.p`
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
`;

const HiddenCanvas = styled.canvas` display: none; `;

const VisionOverlay = ({ isOpen, onClose, onCaptureReady }) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [isEnabled, setIsEnabled] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [preferredFacing, setPreferredFacing] = useState(null);

  const captureFrame = useCallback(() => {
    if (!isEnabled) return null;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72).split(',')[1] || null;
  }, [isEnabled]);

  useEffect(() => {
    onCaptureReady?.(captureFrame);
  }, [captureFrame, onCaptureReady]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isEnabled) {
      setIsReady(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }

    let cancelled = false;

    const start = async () => {
      try {
        const constraints = selectedDeviceId
          ? { video: { deviceId: { exact: selectedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }
          : preferredFacing
            ? { video: { facingMode: { ideal: preferredFacing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }
            : { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setIsReady(true);
        setErrorText('');

        try {
          const list = await navigator.mediaDevices.enumerateDevices();
          setDevices(list.filter(d => d.kind === 'videoinput'));
        } catch { /* ignore */ }
      } catch (err) {
        setIsReady(false);
        setErrorText(err?.name === 'NotAllowedError' ? 'Camera permission denied' : 'Unable to start camera');
      }
    };

    start();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, [isEnabled, selectedDeviceId, preferredFacing]);

  if (!isOpen) return null;

  return (
    <Overlay role="dialog" aria-label="Vision camera">
      <CloseButton onClick={onClose} aria-label="Close vision overlay">×</CloseButton>
      <Title>Vision</Title>

      <ToggleButton
        type="button"
        $active={isEnabled}
        onClick={() => setIsEnabled(prev => !prev)}
      >
        {isEnabled ? 'Disable Camera' : 'Enable Camera'}
      </ToggleButton>

      {isEnabled && (
        <>
          <VideoPreview ref={videoRef} autoPlay muted playsInline />
          <Controls>
            <ControlButton
              $active={preferredFacing === 'user'}
              onClick={() => { setPreferredFacing('user'); setSelectedDeviceId(null); }}
            >
              Front Camera
            </ControlButton>
            <ControlButton
              $active={preferredFacing === 'environment'}
              onClick={() => { setPreferredFacing('environment'); setSelectedDeviceId(null); }}
            >
              Back Camera
            </ControlButton>
          </Controls>
          {devices.length > 1 && (
            <select
              value={selectedDeviceId || ''}
              onChange={e => { setSelectedDeviceId(e.target.value || null); setPreferredFacing(null); }}
              style={{
                background: 'rgba(10,18,38,0.8)',
                color: '#cfe6ff',
                border: '1px solid rgba(110,132,177,0.3)',
                padding: '8px 12px',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              aria-label="Select camera device"
            >
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
              ))}
            </select>
          )}
        </>
      )}

      <StatusText>
        {errorText || (isEnabled && isReady ? 'Camera active — frames attach to voice commands' : 'Enable camera to attach live frames')}
      </StatusText>
      <HiddenCanvas ref={canvasRef} />
    </Overlay>
  );
};

export default VisionOverlay;
