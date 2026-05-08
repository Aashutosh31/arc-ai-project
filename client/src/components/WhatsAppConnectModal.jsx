import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';

const Overlay = styled.div`
  position: fixed; inset:0; background: rgba(0,0,0,0.6); display:flex;align-items:center;justify-content:center; z-index:2000;
`;
const Modal = styled.div`
  background:#071225; padding:18px; border-radius:12px; width:420px; color:#e6eefc; border:1px solid rgba(100,120,180,0.12);
`;
const Header = styled.div`display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;`;
const Title = styled.h3`margin:0;color:#8be4ff;font-size:16px;`;
const Close = styled.button`background:transparent;border:none;color:#9fb6ff;cursor:pointer;`;
const QRBox = styled.div`background:#021024;border-radius:8px;padding:12px;min-height:180px;display:flex;align-items:center;justify-content:center;`;
const Row = styled.div`display:flex;gap:8px;align-items:center;margin-top:12px;`;
const Info = styled.p`margin:0;color:#cfe8ff;font-size:13px;`;
const Input = styled.input`flex:1;padding:8px 10px;border-radius:8px;border:1px solid rgba(120,120,160,0.35);background:#071025;color:#e6eefc;`;
const Button = styled.button`padding:8px 12px;border-radius:8px;background:linear-gradient(90deg,#19a7ff,#7ce3ff);border:none;color:#05202b;font-weight:700;cursor:pointer;`;

export default function WhatsAppConnectModal({ isOpen, onClose, onConnected }) {
  const { socket } = useSocket();
  const [qr, setQr] = useState(null);
  const [pairingCode, setPairingCode] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [status, setStatus] = useState('idle');
  const [mode, setMode] = useState('qr');

  useEffect(() => {
    if (!socket) return;
    const onQr = (d) => { setQr(d.qrcode || null); setStatus('qr'); };
    const onAuth = () => { setStatus('authenticated'); };
    const onReady = () => { setStatus('ready'); setTimeout(()=>{ onClose && onClose(); onConnected && onConnected(); }, 800); };
    const onDisconnected = () => { setStatus('disconnected'); };
    const onPairingCode = (d) => {
      setPairingCode(d?.code || null);
      setStatus('pairing_code');
      setMode('pairing');
    };

    socket.on('whatsapp:qr', onQr);
    socket.on('whatsapp:authenticated', onAuth);
    socket.on('whatsapp:ready', onReady);
    socket.on('whatsapp:disconnected', onDisconnected);
    socket.on('whatsapp:pairing_code', onPairingCode);

    return () => {
      socket.off('whatsapp:qr', onQr);
      socket.off('whatsapp:authenticated', onAuth);
      socket.off('whatsapp:ready', onReady);
      socket.off('whatsapp:disconnected', onDisconnected);
      socket.off('whatsapp:pairing_code', onPairingCode);
    };
  }, [socket, onClose, onConnected]);

  if (!isOpen) return null;

  const handleScanHelp = () => {
    window.open('https://faq.whatsapp.com/general/28030021', '_blank');
  };

  const handleRequestPairingCode = () => {
    if (!socket || !phoneNumber.trim()) return;
    setMode('pairing');
    setStatus('requesting_pairing_code');
    setPairingCode(null);
    socket.emit('whatsapp:pair_with_phone', { phoneNumber: phoneNumber.trim() }, (err) => {
      if (err) setStatus('pairing_failed');
    });
  };

  return (
    <Overlay>
      <Modal>
        <Header>
          <Title>Connect WhatsApp</Title>
          <Close onClick={onClose}>Close</Close>
        </Header>

        <QRBox>
          {mode === 'pairing' ? (
            pairingCode ? (
              <div style={{textAlign:'center'}}>
                <div style={{fontSize:12,color:'#93b7ff',marginBottom:6}}>Pairing code</div>
                <div style={{fontSize:28,fontWeight:800,letterSpacing:'0.16em',color:'#7ce3ff'}}>{pairingCode}</div>
              </div>
            ) : (
              <div style={{color:'#93b7ff'}}>Waiting for pairing code...</div>
            )
          ) : qr ? <img src={qr} alt="WhatsApp QR" style={{maxWidth:'100%',maxHeight:160}} /> : <div style={{color:'#93b7ff'}}>Waiting for QR...</div>}
        </QRBox>

        <Row>
          <Info>
            Status: <strong style={{color: status === 'ready' ? '#7df7ff' : '#ffdca3'}}>{status}</strong>
            <br />
            {mode === 'pairing'
              ? 'Enter the pairing code in WhatsApp → Linked devices → Link with phone number. ARC will remember your session.'
              : 'Scan the QR once from WhatsApp → Linked devices → Link a device. ARC will remember your session.'}
          </Info>
        </Row>

        <Row>
          <Input
            placeholder="Phone number in international format, e.g. 15551234567"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
          />
        </Row>

        <Row>
          <Button onClick={handleScanHelp}>How to scan</Button>
          <Button onClick={handleRequestPairingCode}>Use phone number</Button>
        </Row>
      </Modal>
    </Overlay>
  );
}
