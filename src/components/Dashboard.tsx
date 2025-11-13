import React, { useEffect, useState, useRef } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  RadialLinearScale,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Doughnut, Bar, Radar } from 'react-chartjs-2';
import './Dashboard.css';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  RadialLinearScale,
  Title,
  Tooltip,
  Legend,
  Filler
);

// Types
interface DeviceStats {
  mac: string;
  ip: string;
  bytesSent: number;
  bytesRecv: number;
  packetsSent: number;
  packetsRecv: number;
  lastSeen: string;
  hostname: string;
}

interface NetworkStats {
  devices: DeviceStats[];
  totalSent: number;
  totalRecv: number;
  totalPackets: number;
  activeDevices: number;
  monitorDuration: number;
  timestamp: string;
}

interface ChartDataPoint {
  timestamp: string;
  devices: Map<string, { upload: number; download: number }>;
}

// Utility: Get WebSocket URL
const getWebSocketUrl = (): string => {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;
  const port = import.meta.env.VITE_WS_PORT || '8080';
  return `${protocol}//${host}:${port}/ws`;
};

// Utility: Format bytes
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

// Utility: Format rate
const formatRate = (bytes: number, duration: number): string => {
  if (duration === 0) return '0 B/s';
  const bytesPerSec = bytes / duration;
  return `${formatBytes(bytesPerSec)}/s`;
};

// Generate vibrant colors
const generateColor = (index: number, opacity: number = 1): string => {
  const colors = [
    `rgba(0, 255, 255, ${opacity})`,    // Cyan
    `rgba(255, 0, 255, ${opacity})`,    // Magenta
    `rgba(0, 255, 127, ${opacity})`,    // Spring Green
    `rgba(255, 215, 0, ${opacity})`,    // Gold
    `rgba(255, 69, 0, ${opacity})`,     // Red-Orange
    `rgba(138, 43, 226, ${opacity})`,   // Blue Violet
    `rgba(0, 191, 255, ${opacity})`,    // Deep Sky Blue
    `rgba(255, 20, 147, ${opacity})`,   // Deep Pink
  ];
  return colors[index % colors.length];
};

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [chartHistory, setChartHistory] = useState<ChartDataPoint[]>([]);
  const [wsUrl, setWsUrl] = useState<string>('');
  const [currentTime, setCurrentTime] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const previousStatsRef = useRef<Map<string, { sent: number; recv: number }>>(new Map());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const MAX_HISTORY_POINTS = 50;

  // Update time
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(now.toLocaleTimeString('en-US', { 
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }));
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const url = getWebSocketUrl();
    setWsUrl(url);
    console.log('WebSocket URL:', url);
  }, []);

  useEffect(() => {
    if (!wsUrl) return;

    const connectWebSocket = () => {
      try {
        console.log('Attempting to connect to:', wsUrl);
        const websocket = new WebSocket(wsUrl);

        websocket.onopen = () => {
          console.log('WebSocket connected successfully');
          setConnectionStatus('connected');
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
        };

        websocket.onmessage = (event) => {
          const data: NetworkStats = JSON.parse(event.data);
          setStats(data);

          const timestamp = new Date().toLocaleTimeString('en-US', { 
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
          const deviceRates = new Map<string, { upload: number; download: number }>();

          data.devices.forEach((device) => {
            const key = device.mac;
            const prev = previousStatsRef.current.get(key);

            if (prev) {
              const uploadRate = device.bytesSent - prev.sent;
              const downloadRate = device.bytesRecv - prev.recv;
              deviceRates.set(key, {
                upload: Math.max(0, uploadRate),
                download: Math.max(0, downloadRate),
              });
            } else {
              deviceRates.set(key, { upload: 0, download: 0 });
            }

            previousStatsRef.current.set(key, {
              sent: device.bytesSent,
              recv: device.bytesRecv,
            });
          });

          setChartHistory((prev) => {
            const newHistory = [...prev, { timestamp, devices: deviceRates }];
            return newHistory.slice(-MAX_HISTORY_POINTS);
          });
        };

        websocket.onerror = (error) => {
          console.error('WebSocket error:', error);
          setConnectionStatus('disconnected');
        };

        websocket.onclose = (event) => {
          console.log('WebSocket disconnected:', event.code, event.reason);
          setConnectionStatus('disconnected');
          
          if (!reconnectTimeoutRef.current) {
            reconnectTimeoutRef.current = setTimeout(() => {
              reconnectTimeoutRef.current = null;
              connectWebSocket();
            }, 3000);
          }
        };

        wsRef.current = websocket;
      } catch (error) {
        console.error('Error creating WebSocket:', error);
        setConnectionStatus('disconnected');
        
        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            connectWebSocket();
          }, 3000);
        }
      }
    };

    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [wsUrl]);

  // Chart configurations with glowing effects
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 750,
      easing: 'easeInOutQuart' as const,
    },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        labels: {
          color: '#00FFFF',
          font: { size: 11, family: 'Orbitron, monospace' },
          usePointStyle: true,
          padding: 12,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        titleColor: '#00FFFF',
        bodyColor: '#FFFFFF',
        borderColor: '#00FFFF',
        borderWidth: 1,
        padding: 12,
        displayColors: true,
        callbacks: {
          label: (context: any) => `${context.dataset.label}: ${context.parsed.y.toFixed(2)} KB/s`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(0, 255, 255, 0.1)', drawBorder: false },
        ticks: { color: '#00FFFF', font: { size: 9, family: 'Orbitron, monospace' }, maxTicksLimit: 10 },
      },
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(0, 255, 255, 0.1)', drawBorder: false },
        ticks: {
          color: '#00FFFF',
          font: { size: 9, family: 'Orbitron, monospace' },
          callback: (value: any) => `${value} KB/s`,
        },
      },
    },
  };

  // Real-time bandwidth chart
  const bandwidthChartData = {
    labels: chartHistory.map((point) => point.timestamp),
    datasets: stats?.devices.map((device, index) => ({
      label: device.ip || device.mac.slice(0, 8),
      data: chartHistory.map((point) => {
        const deviceData = point.devices.get(device.mac);
        return deviceData ? (deviceData.upload + deviceData.download) / 1024 : 0;
      }),
      borderColor: generateColor(index, 1),
      backgroundColor: generateColor(index, 0.1),
      borderWidth: 2,
      tension: 0.4,
      fill: true,
      pointRadius: 0,
      pointHoverRadius: 4,
    })) || [],
  };

  // Traffic distribution pie chart
  const trafficDistributionData = {
    labels: stats?.devices.map((d, i) => `Device ${i + 1}`) || [],
    datasets: [{
      data: stats?.devices.map(d => d.bytesSent + d.bytesRecv) || [],
      backgroundColor: stats?.devices.map((_, i) => generateColor(i, 0.8)) || [],
      borderColor: stats?.devices.map((_, i) => generateColor(i, 1)) || [],
      borderWidth: 2,
    }],
  };

  // Upload vs Download bar chart
  const uploadDownloadData = {
    labels: stats?.devices.map((d, i) => `D${i + 1}`) || [],
    datasets: [
      {
        label: 'Upload',
        data: stats?.devices.map(d => d.bytesSent / 1024 / 1024) || [],
        backgroundColor: 'rgba(0, 255, 127, 0.6)',
        borderColor: 'rgba(0, 255, 127, 1)',
        borderWidth: 2,
      },
      {
        label: 'Download',
        data: stats?.devices.map(d => d.bytesRecv / 1024 / 1024) || [],
        backgroundColor: 'rgba(255, 0, 255, 0.6)',
        borderColor: 'rgba(255, 0, 255, 1)',
        borderWidth: 2,
      },
    ],
  };

  // Packets radar chart
  const packetsRadarData = {
    labels: stats?.devices.slice(0, 6).map((d, i) => `Device ${i + 1}`) || [],
    datasets: [{
      label: 'Packets Sent',
      data: stats?.devices.slice(0, 6).map(d => d.packetsSent / 1000) || [],
      backgroundColor: 'rgba(0, 255, 255, 0.2)',
      borderColor: 'rgba(0, 255, 255, 1)',
      borderWidth: 2,
      pointBackgroundColor: 'rgba(0, 255, 255, 1)',
    }, {
      label: 'Packets Received',
      data: stats?.devices.slice(0, 6).map(d => d.packetsRecv / 1000) || [],
      backgroundColor: 'rgba(255, 0, 255, 0.2)',
      borderColor: 'rgba(255, 0, 255, 1)',
      borderWidth: 2,
      pointBackgroundColor: 'rgba(255, 0, 255, 1)',
    }],
  };

  const pieOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          color: '#00FFFF',
          font: { size: 10, family: 'Orbitron, monospace' },
          padding: 10,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        titleColor: '#00FFFF',
        bodyColor: '#FFFFFF',
        borderColor: '#00FFFF',
        borderWidth: 1,
        callbacks: {
          label: (context: any) => `${context.label}: ${formatBytes(context.parsed)}`,
        },
      },
    },
  };

  const barOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: '#00FFFF',
          font: { size: 11, family: 'Orbitron, monospace' },
        },
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        titleColor: '#00FFFF',
        bodyColor: '#FFFFFF',
        borderColor: '#00FFFF',
        borderWidth: 1,
        callbacks: {
          label: (context: any) => `${context.dataset.label}: ${context.parsed.y.toFixed(2)} MB`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(0, 255, 255, 0.1)' },
        ticks: { color: '#00FFFF', font: { family: 'Orbitron, monospace' } },
      },
      y: {
        grid: { color: 'rgba(0, 255, 255, 0.1)' },
        ticks: { 
          color: '#00FFFF',
          font: { family: 'Orbitron, monospace' },
          callback: (value: any) => `${value} MB`,
        },
      },
    },
  };

  const radarOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: '#00FFFF',
          font: { size: 11, family: 'Orbitron, monospace' },
        },
      },
    },
    scales: {
      r: {
        grid: { color: 'rgba(0, 255, 255, 0.2)' },
        angleLines: { color: 'rgba(0, 255, 255, 0.2)' },
        pointLabels: {
          color: '#00FFFF',
          font: { size: 10, family: 'Orbitron, monospace' },
        },
        ticks: {
          color: '#00FFFF',
          backdropColor: 'transparent',
          font: { family: 'Orbitron, monospace' },
        },
      },
    },
  };

  if (!stats) {
    return (
      <div className="jarvis-loading">
        <div className="jarvis-spinner">
          <div className="spinner-ring"></div>
          <div className="spinner-ring"></div>
          <div className="spinner-ring"></div>
        </div>
        <p className="jarvis-loading-text">
          {connectionStatus === 'connecting' && 'INITIALIZING NETWORK MONITOR...'}
          {connectionStatus === 'disconnected' && 'CONNECTION LOST - RECONNECTING...'}
        </p>
        {wsUrl && <p className="jarvis-loading-subtext">{wsUrl}</p>}
      </div>
    );
  }

  return (
    <div className="jarvis-dashboard">
      {/* Animated background grid */}
      <div className="jarvis-grid"></div>
      
      {/* Scanlines effect */}
      <div className="scanlines"></div>

      {/* Header */}
      <header className="jarvis-header">
        <div className="jarvis-header-left">
          <div className="jarvis-logo">
            <div className="logo-core"></div>
            <div className="logo-ring"></div>
          </div>
          <div>
            <h1 className="jarvis-title">K.E.E.P.E.R</h1>
            <p className="jarvis-subtitle">Network Monitoring System</p>
          </div>
        </div>
        <div className="jarvis-header-right">
          <div className="jarvis-time">{currentTime}</div>
          <div className={`jarvis-status jarvis-status-${connectionStatus}`}>
            <span className="status-dot"></span>
            {connectionStatus.toUpperCase()}
          </div>
        </div>
      </header>

      {/* Stats Panel */}
      <div className="jarvis-stats-panel">
        <div className="jarvis-stat-card">
          <div className="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
          </div>
          <div className="stat-data">
            <div className="stat-value">{stats.activeDevices}</div>
            <div className="stat-label">ACTIVE DEVICES</div>
          </div>
          <div className="stat-glow stat-glow-cyan"></div>
        </div>

        <div className="jarvis-stat-card">
          <div className="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </div>
          <div className="stat-data">
            <div className="stat-value">{formatBytes(stats.totalSent)}</div>
            <div className="stat-label">TOTAL UPLOAD</div>
            <div className="stat-rate">{formatRate(stats.totalSent, stats.monitorDuration)}</div>
          </div>
          <div className="stat-glow stat-glow-green"></div>
        </div>

        <div className="jarvis-stat-card">
          <div className="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <polyline points="19 12 12 19 5 12"></polyline>
            </svg>
          </div>
          <div className="stat-data">
            <div className="stat-value">{formatBytes(stats.totalRecv)}</div>
            <div className="stat-label">TOTAL DOWNLOAD</div>
            <div className="stat-rate">{formatRate(stats.totalRecv, stats.monitorDuration)}</div>
          </div>
          <div className="stat-glow stat-glow-magenta"></div>
        </div>

        <div className="jarvis-stat-card">
          <div className="stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
              <path d="M2 17l10 5 10-5"></path>
              <path d="M2 12l10 5 10-5"></path>
            </svg>
          </div>
          <div className="stat-data">
            <div className="stat-value">{(stats.totalPackets / 1000).toFixed(1)}K</div>
            <div className="stat-label">TOTAL PACKETS</div>
          </div>
          <div className="stat-glow stat-glow-yellow"></div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="jarvis-charts-grid">
        {/* Main bandwidth chart */}
        <div className="jarvis-chart-container jarvis-chart-main">
          <div className="chart-header">
            <h3 className="chart-title">REAL-TIME BANDWIDTH MONITOR</h3>
            <div className="chart-badge">LIVE</div>
          </div>
          <div className="chart-content">
            <Line data={bandwidthChartData} options={chartOptions} />
          </div>
        </div>

        {/* Traffic distribution */}
        <div className="jarvis-chart-container">
          <div className="chart-header">
            <h3 className="chart-title">TRAFFIC DISTRIBUTION</h3>
          </div>
          <div className="chart-content">
            <Doughnut data={trafficDistributionData} options={pieOptions} />
          </div>
        </div>

        {/* Upload vs Download */}
        <div className="jarvis-chart-container">
          <div className="chart-header">
            <h3 className="chart-title">UPLOAD VS DOWNLOAD</h3>
          </div>
          <div className="chart-content">
            <Bar data={uploadDownloadData} options={barOptions} />
          </div>
        </div>

        {/* Packets radar */}
        <div className="jarvis-chart-container">
          <div className="chart-header">
            <h3 className="chart-title">PACKET ANALYSIS</h3>
          </div>
          <div className="chart-content">
            <Radar data={packetsRadarData} options={radarOptions} />
          </div>
        </div>
      </div>

      {/* Devices Table */}
      <div className="jarvis-devices-panel">
        <div className="panel-header">
          <h3 className="panel-title">CONNECTED DEVICES</h3>
          <div className="panel-count">{stats.devices.length} DEVICES</div>
        </div>
        <div className="devices-table-wrapper">
          <table className="jarvis-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>MAC ADDRESS</th>
                <th>IP ADDRESS</th>
                <th>UPLOAD</th>
                <th>DOWNLOAD</th>
                <th>PACKETS</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {stats.devices.map((device, index) => {
                const currentRate = chartHistory.length > 0
                  ? chartHistory[chartHistory.length - 1].devices.get(device.mac)
                  : null;
                const uploadRate = currentRate ? (currentRate.upload / 1024).toFixed(2) : '0.00';
                const downloadRate = currentRate ? (currentRate.download / 1024).toFixed(2) : '0.00';

                return (
                  <tr key={device.mac} className="table-row-animated">
                    <td>
                      <div className="device-id" style={{ borderColor: generateColor(index) }}>
                        {String(index + 1).padStart(2, '0')}
                      </div>
                    </td>
                    <td className="mono-font">{device.mac}</td>
                    <td className="ip-address">{device.ip || '—'}</td>
                    <td className="data-cell">
                      <span className="data-value">{formatBytes(device.bytesSent)}</span>
                      <span className="data-rate">{uploadRate} KB/s</span>
                    </td>
                    <td className="data-cell">
                      <span className="data-value">{formatBytes(device.bytesRecv)}</span>
                      <span className="data-rate">{downloadRate} KB/s</span>
                    </td>
                    <td className="mono-font">{device.packetsSent + device.packetsRecv}</td>
                    <td>
                      <span className="status-badge status-active">ACTIVE</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <footer className="jarvis-footer">
        <div className="footer-text">
          LAST UPDATE: {new Date(stats.timestamp).toLocaleString()} • 
          UPTIME: {Math.floor(stats.monitorDuration / 60)}m {Math.floor(stats.monitorDuration % 60)}s
        </div>
      </footer>
    </div>
  );
};

export default Dashboard;