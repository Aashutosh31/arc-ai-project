import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
`;

const Modal = styled.div`
  background: #0b0b1b;
  border: 1px solid rgba(100,100,140,0.6);
  padding: 18px;
  border-radius: 12px;
  width: 420px;
  max-width: calc(100% - 32px);
  color: #dfe6ff;
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
`;

const Title = styled.h3`
  margin: 0;
  font-size: 16px;
  color: #8be4ff;
`;

const Close = styled.button`
  background: transparent;
  border: none;
  color: #aaa;
  cursor: pointer;
`;

const QRBox = styled.div`
  background: #061127;
  border-radius: 8px;
  padding: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
`;

const StatusList = styled.ul`
  list-style: none;
  padding: 6px 0 0;
  margin: 10px 0 0;
  max-height: 120px;
  overflow: auto;
  font-size: 13px;
`;

const StatusItem = styled.li`
  margin: 6px 0;
  color: #cbd8ff;
`;

const Controls = styled.div`
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-direction: column;
`;

const Row = styled.div`
  display:flex; gap:8px; align-items: center;
`;

const Input = styled.input`
  flex:1; padding:8px;border-radius:8px;border:1px solid rgba(120,120,160,0.35);background:#071025;color:#e6eefc;
`;

const Textarea = styled.textarea`
  width:100%; min-height:80px; padding:8px;border-radius:8px;border:1px solid rgba(120,120,160,0.35);background:#071025;color:#e6eefc;
`;

const Button = styled.button`
  padding:8px 10px;border-radius:8px;background:linear-gradient(90deg,#19a7ff,#7ce3ff);border:none;color:#05202b;font-weight:700;cursor:pointer;
`;

export default function WhatsAppModal({ isOpen, onClose }) {
  const { socket } = useSocket();
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [status, setStatus] = useState('idle');
  const [logs, setLogs] = useState([]);
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!socket) return;

    const push = (text) => setLogs((s) => [text, ...s].slice(0, 50));

    const onQr = (data) => {
      setQrDataUrl(data.qrcode || null);
      setStatus('qr');
      push('QR generated');
    };

    const onAuthenticated = () => {
      setStatus('authenticated');
      push('Authenticated');
    };

    const onReady = () => {
      setStatus('ready');
      push('Ready');
      // auto-close after ready
      setTimeout(() => onClose && onClose(), 800);
    };

    const onDisconnected = (d) => {
      setStatus('disconnected');
      push('Disconnected');
    };

    const onSent = (d) => {
      push(`Message sent: ${d?.id || 'ok'}`);
    };

    const onFailed = (d) => {
      push(`Send failed: ${d?.error || JSON.stringify(d)}`);
    };

    const onContactsSynced = (d) => {
      push(`Contacts indexed: ${d?.count ?? 0}`);
    };

    const onContactsSyncFailed = (d) => {
      push(`Contact sync failed: ${d?.error || 'unknown error'}`);
    };

    socket.on('whatsapp:qr', onQr);
    socket.on('whatsapp:authenticated', onAuthenticated);
    socket.on('whatsapp:ready', onReady);
    socket.on('whatsapp:disconnected', onDisconnected);
    socket.on('whatsapp:message_sent', onSent);
    socket.on('whatsapp:message_failed', onFailed);
    socket.on('whatsapp:contacts_synced', onContactsSynced);
    socket.on('whatsapp:contacts_sync_failed', onContactsSyncFailed);

    socket.emit('whatsapp:sync_contacts');

    return () => {
      socket.off('whatsapp:qr', onQr);
      socket.off('whatsapp:authenticated', onAuthenticated);
      socket.off('whatsapp:ready', onReady);
      socket.off('whatsapp:disconnected', onDisconnected);
      socket.off('whatsapp:message_sent', onSent);
      socket.off('whatsapp:message_failed', onFailed);
      socket.off('whatsapp:contacts_synced', onContactsSynced);
      socket.off('whatsapp:contacts_sync_failed', onContactsSyncFailed);
    };
  }, [socket, onClose]);

  if (!isOpen) return null;

  const handleSend = () => {
    if (!socket) return;
    setLogs((s) => [`Sending to ${to}`,...s].slice(0,50));
    socket.emit('whatsapp:send', { recipientName: to, message }, (err, res) => {
      if (err) setLogs((s) => [`send callback error: ${String(err)}`,...s].slice(0,50));
      else setLogs((s) => [`send callback ok: ${JSON.stringify(res)}`,...s].slice(0,50));
    });
  };

  return (
    <Overlay>
      <Modal>
        <Header>
          <Title>WhatsApp Connect</Title>
          <Close onClick={onClose}>Close</Close>
        </Header>

        <QRBox>
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="WhatsApp QR" style={{maxWidth:'100%',maxHeight:160}} />
          ) : (
            <div style={{color:'#93b7ff'}}>Waiting for QR...</div>
          )}
        </QRBox>

        <StatusList>
          <StatusItem>Status: {status}</StatusItem>
          {logs.map((l, i) => <StatusItem key={i}>{l}</StatusItem>)}
        </StatusList>

        <Controls>
          <Row>
            <Input placeholder="Recipient name or alias" value={to} onChange={(e)=>setTo(e.target.value)} />
            <Button type="button" onClick={handleSend}>Send</Button>
          </Row>
          <Textarea placeholder="Message" value={message} onChange={(e)=>setMessage(e.target.value)} />
        </Controls>
      </Modal>
    </Overlay>
  );
}
