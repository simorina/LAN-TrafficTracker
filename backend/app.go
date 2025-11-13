package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
	"github.com/google/gopacket/pcap"
	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/rs/cors"
)

// DeviceStats holds bandwidth statistics for a network device
type DeviceStats struct {
	MAC         string    `json:"mac"`
	IP          string    `json:"ip"`
	BytesSent   uint64    `json:"bytesSent"`
	BytesRecv   uint64    `json:"bytesRecv"`
	PacketsSent uint64    `json:"packetsSent"`
	PacketsRecv uint64    `json:"packetsRecv"`
	LastSeen    time.Time `json:"lastSeen"`
	Hostname    string    `json:"hostname"`
}

// NetworkStats holds overall network statistics
type NetworkStats struct {
	Devices         []*DeviceStats `json:"devices"`
	TotalSent       uint64         `json:"totalSent"`
	TotalRecv       uint64         `json:"totalRecv"`
	TotalPackets    uint64         `json:"totalPackets"`
	ActiveDevices   int            `json:"activeDevices"`
	MonitorDuration float64        `json:"monitorDuration"` // seconds
	Timestamp       time.Time      `json:"timestamp"`
}

// BandwidthMonitor manages bandwidth statistics for multiple devices
type BandwidthMonitor struct {
	devices   map[string]*DeviceStats
	mutex     sync.RWMutex
	localIP   string
	startTime time.Time
	clients   map[*websocket.Conn]bool
	clientsMu sync.RWMutex
	broadcast chan *NetworkStats
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in development
	},
}

// NewBandwidthMonitor creates a new BandwidthMonitor instance
func NewBandwidthMonitor(localIP string) *BandwidthMonitor {
	return &BandwidthMonitor{
		devices:   make(map[string]*DeviceStats),
		localIP:   localIP,
		startTime: time.Now(),
		clients:   make(map[*websocket.Conn]bool),
		broadcast: make(chan *NetworkStats, 256),
	}
}

// UpdateStats updates the statistics for a device based on a captured packet
func (bm *BandwidthMonitor) UpdateStats(srcMAC, dstMAC, srcIP, dstIP string, packetSize uint64) {
	bm.mutex.Lock()
	defer bm.mutex.Unlock()
	now := time.Now()

	// Update source device
	if srcMAC != "" && srcMAC != "ff:ff:ff:ff:ff:ff" {
		key := srcMAC
		if _, exists := bm.devices[key]; !exists {
			bm.devices[key] = &DeviceStats{
				MAC: srcMAC,
				IP:  srcIP,
			}
		}
		bm.devices[key].BytesSent += packetSize
		bm.devices[key].PacketsSent++
		bm.devices[key].LastSeen = now
		if srcIP != "" && bm.devices[key].IP == "" {
			bm.devices[key].IP = srcIP
		}
	}

	// Update destination device
	if dstMAC != "" && dstMAC != "ff:ff:ff:ff:ff:ff" {
		key := dstMAC
		if _, exists := bm.devices[key]; !exists {
			bm.devices[key] = &DeviceStats{
				MAC: dstMAC,
				IP:  dstIP,
			}
		}
		bm.devices[key].BytesRecv += packetSize
		bm.devices[key].PacketsRecv++
		bm.devices[key].LastSeen = now
		if dstIP != "" && bm.devices[key].IP == "" {
			bm.devices[key].IP = dstIP
		}
	}
}

// GetNetworkStats returns current network statistics
func (bm *BandwidthMonitor) GetNetworkStats() *NetworkStats {
	bm.mutex.RLock()
	defer bm.mutex.RUnlock()

	devices := make([]*DeviceStats, 0, len(bm.devices))
	var totalSent, totalRecv, totalPackets uint64

	for _, dev := range bm.devices {
		devCopy := *dev
		devices = append(devices, &devCopy)
		totalSent += dev.BytesSent
		totalRecv += dev.BytesRecv
		totalPackets += dev.PacketsSent + dev.PacketsRecv
	}

	// Sort by total bandwidth
	sort.Slice(devices, func(i, j int) bool {
		totalI := devices[i].BytesSent + devices[i].BytesRecv
		totalJ := devices[j].BytesSent + devices[j].BytesRecv
		return totalI > totalJ
	})

	return &NetworkStats{
		Devices:         devices,
		TotalSent:       totalSent,
		TotalRecv:       totalRecv,
		TotalPackets:    totalPackets,
		ActiveDevices:   len(devices),
		MonitorDuration: time.Since(bm.startTime).Seconds(),
		Timestamp:       time.Now(),
	}
}

// WebSocket handler
func (bm *BandwidthMonitor) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Register client
	bm.clientsMu.Lock()
	bm.clients[conn] = true
	bm.clientsMu.Unlock()

	log.Printf("WebSocket client connected from %s. Total clients: %d", r.RemoteAddr, len(bm.clients))

	// Send initial data
	stats := bm.GetNetworkStats()
	if err := conn.WriteJSON(stats); err != nil {
		log.Printf("Error sending initial data: %v", err)
	}

	// Keep connection alive and handle disconnection
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			bm.clientsMu.Lock()
			delete(bm.clients, conn)
			bm.clientsMu.Unlock()
			log.Printf("WebSocket client disconnected from %s. Total clients: %d", r.RemoteAddr, len(bm.clients))
			break
		}
	}
}

// Broadcast stats to all WebSocket clients
func (bm *BandwidthMonitor) broadcastStats() {
	for stats := range bm.broadcast {
		bm.clientsMu.RLock()
		for client := range bm.clients {
			if err := client.WriteJSON(stats); err != nil {
				log.Printf("Error broadcasting to client: %v", err)
				client.Close()
				bm.clientsMu.Lock()
				delete(bm.clients, client)
				bm.clientsMu.Unlock()
			}
		}
		bm.clientsMu.RUnlock()
	}
}

// REST API: Get current stats
func (bm *BandwidthMonitor) handleGetStats(w http.ResponseWriter, r *http.Request) {
	stats := bm.GetNetworkStats()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// REST API: Get specific device stats
func (bm *BandwidthMonitor) handleGetDevice(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	mac := vars["mac"]

	bm.mutex.RLock()
	device, exists := bm.devices[mac]
	bm.mutex.RUnlock()

	if !exists {
		http.Error(w, "Device not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(device)
}

// REST API: Health check
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// getLocalIP retrieves the local IP address of the machine
func getLocalIP(deviceName string, devices []pcap.Interface) string {
	for _, dev := range devices {
		if dev.Name == deviceName {
			for _, addr := range dev.Addresses {
				if ipv4 := addr.IP.To4(); ipv4 != nil {
					return ipv4.String()
				}
			}
		}
	}
	return ""
}

func main() {
	// Command-line flags
	devicePtr := flag.String("device", "", "Network device to monitor")
	hostPtr := flag.String("host", "0.0.0.0", "Host address to bind (0.0.0.0 for all interfaces)")
	portPtr := flag.String("port", "8080", "HTTP server port")
	intervalPtr := flag.Int("interval", 2, "Broadcast interval in seconds")
	listPtr := flag.Bool("list", false, "List available devices and exit")

	flag.Parse()

	// Find all devices
	devices, err := pcap.FindAllDevs()
	if err != nil {
		log.Fatal(err)
	}

	// List devices and exit
	if *listPtr {
		fmt.Println("Available network devices:")
		for i, device := range devices {
			fmt.Printf("[%d] %s", i, device.Name)
			if device.Description != "" {
				fmt.Printf(" (%s)", device.Description)
			}
			fmt.Println()
			for _, address := range device.Addresses {
				fmt.Printf("    IP: %s\n", address.IP)
			}
		}
		os.Exit(0)
	}

	if len(devices) == 0 {
		log.Fatal("No devices found")
	}

	// Select device
	var deviceName string
	var localIP string

	if *devicePtr != "" {
		deviceName = *devicePtr
	} else {
		for _, dev := range devices {
			if dev.Name != "lo" && len(dev.Addresses) > 0 {
				deviceName = dev.Name
				if len(dev.Addresses) > 0 {
					localIP = dev.Addresses[0].IP.String()
				}
				break
			}
		}
		if deviceName == "" {
			deviceName = devices[0].Name
		}
	}

	// Get local IP if not set
	if localIP == "" {
		localIP = getLocalIP(deviceName, devices)
	}

	fmt.Printf("Starting bandwidth monitor on device: %s\n", deviceName)
	if localIP != "" {
		fmt.Printf("Local IP: %s\n", localIP)
		fmt.Printf("Access from other devices: http://%s:%s\n", localIP, *portPtr)
	}
	fmt.Printf("HTTP server binding to: %s:%s\n", *hostPtr, *portPtr)

	// Open device
	handle, err := pcap.OpenLive(deviceName, 1600, true, pcap.BlockForever)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error opening device: %v\n\n", err)
		fmt.Fprintf(os.Stderr, "Hint: You may need root/sudo or capabilities\n")
		os.Exit(1)
	}
	defer handle.Close()

	// Create bandwidth monitor
	monitor := NewBandwidthMonitor(localIP)

	// Start WebSocket broadcaster
	go monitor.broadcastStats()

	// Start packet capture
	packetSource := gopacket.NewPacketSource(handle, handle.LinkType())
	packets := packetSource.Packets()

	go func() {
		for packet := range packets {
			var srcMAC, dstMAC, srcIP, dstIP string

			if ethLayer := packet.Layer(layers.LayerTypeEthernet); ethLayer != nil {
				eth := ethLayer.(*layers.Ethernet)
				srcMAC = eth.SrcMAC.String()
				dstMAC = eth.DstMAC.String()
			}

			if ipLayer := packet.Layer(layers.LayerTypeIPv4); ipLayer != nil {
				ip := ipLayer.(*layers.IPv4)
				srcIP = ip.SrcIP.String()
				dstIP = ip.DstIP.String()
			}

			packetSize := uint64(len(packet.Data()))
			monitor.UpdateStats(srcMAC, dstMAC, srcIP, dstIP, packetSize)
		}
	}()

	// Periodic broadcast to WebSocket clients
	ticker := time.NewTicker(time.Duration(*intervalPtr) * time.Second)
	go func() {
		for range ticker.C {
			stats := monitor.GetNetworkStats()
			select {
			case monitor.broadcast <- stats:
			default:
				// Channel full, skip this update
			}
		}
	}()

	// Setup HTTP server with CORS
	router := mux.NewRouter()

	// REST API routes
	router.HandleFunc("/api/health", handleHealth).Methods("GET")
	router.HandleFunc("/api/stats", monitor.handleGetStats).Methods("GET")
	router.HandleFunc("/api/devices/{mac}", monitor.handleGetDevice).Methods("GET")

	// WebSocket route
	router.HandleFunc("/ws", monitor.handleWebSocket)

	// CORS configuration
	c := cors.New(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
	})

	handler := c.Handler(router)

	// Start HTTP server
	addr := *hostPtr + ":" + *portPtr
	server := &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("Server starting on %s", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-sigChan
	log.Println("\nShutting down server...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(ctx)
}
