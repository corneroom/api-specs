# Project X API Gateway Deployment Makefile
# Replicates the GitHub Actions workflow for local deployment

.PHONY: help gateway build-swagger deploy-gateway clean sync

# Default target
help: ## Show this help message
	@echo "Project X API Gateway Deployment"
	@echo "================================"
	@echo ""
	@echo "Available commands:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Environment variables (set these or export them)
PROJECT_ID ?= corneroom-82fbb
LOCATION ?= us-central1
API_NAME ?= corneroom-api
CONFIG_PATH ?= gateway/config.json

# Get current git info
SHORT_SHA := $(shell git rev-parse --short HEAD)
TIMESTAMP := $(shell date +'%Y%m%d%H%M%S')

gateway: clean sync build-swagger deploy-gateway ## Deploy API Gateway (build + deploy)

build-swagger: ## Build OpenAPI specs to Swagger 2.0
	@echo "🔨 Building OpenAPI specs to Swagger 2.0..."
	@if [ ! -f package.json ]; then \
		echo "❌ package.json not found. Run 'npm init' first."; \
		exit 1; \
	fi
	@if ! command -v npm >/dev/null 2>&1; then \
		echo "❌ npm not found. Please install Node.js and npm."; \
		exit 1; \
	fi
	@echo "📦 Installing dependencies..."
	@npm ci --cache .npm-cache
	@echo "🔄 Converting OpenAPI specs to Swagger 2.0..."
	@npm run swagger
	@echo "✅ Swagger specs built successfully"

deploy-gateway: ## Deploy API Gateway configs and gateways
	@echo "🚀 Deploying API Gateway..."
	@if ! command -v gcloud >/dev/null 2>&1; then \
		echo "❌ gcloud CLI not found. Please install and authenticate."; \
		exit 1; \
	fi
	@if ! command -v jq >/dev/null 2>&1; then \
		echo "❌ jq not found. Please install jq."; \
		exit 1; \
	fi
	@echo "📋 Reading gateway configuration..."
	@for gw in $$(jq -r '.gateways | keys[]' $(CONFIG_PATH)); do \
		echo "🔧 Processing gateway: $$gw"; \
		GW_SPEC="gateway/$${gw}-swagger.yaml"; \
		STAGING_GW_NAME="$${gw}-staging-gateway"; \
		NEW_API_CONFIG_NAME="$(API_NAME)-$${gw}-staging-$(SHORT_SHA)-$(TIMESTAMP)"; \
		echo "📄 Deploying $$GW_SPEC to $$STAGING_GW_NAME as $$NEW_API_CONFIG_NAME"; \
		\
		echo "🔨 Creating API config: $$NEW_API_CONFIG_NAME"; \
		gcloud api-gateway api-configs create "$$NEW_API_CONFIG_NAME" \
			--api="$(API_NAME)" \
			--openapi-spec="$$GW_SPEC" \
			--project="$(PROJECT_ID)" \
			--backend-auth-service-account="community-service@corneroom-82fbb.iam.gserviceaccount.com"; \
		\
		echo "🔍 Checking if gateway exists: $$STAGING_GW_NAME"; \
		if gcloud api-gateway gateways describe "$$STAGING_GW_NAME" --location="$(LOCATION)" --project="$(PROJECT_ID)" >/dev/null 2>&1; then \
			echo "🔄 Updating existing gateway: $$STAGING_GW_NAME"; \
			gcloud api-gateway gateways update "$$STAGING_GW_NAME" \
				--api="$(API_NAME)" \
				--api-config="$$NEW_API_CONFIG_NAME" \
				--location="$(LOCATION)" \
				--project="$(PROJECT_ID)"; \
		else \
			echo "🆕 Creating new gateway: $$STAGING_GW_NAME"; \
			gcloud api-gateway gateways create "$$STAGING_GW_NAME" \
				--api="$(API_NAME)" \
				--api-config="$$NEW_API_CONFIG_NAME" \
				--location="$(LOCATION)" \
				--project="$(PROJECT_ID)"; \
		fi; \
		\
		echo "🌐 Getting gateway URL..."; \
		GW_URL=$$(gcloud api-gateway gateways describe "$$STAGING_GW_NAME" --location="$(LOCATION)" --project="$(PROJECT_ID)" --format="value(defaultHostname)"); \
		echo "✅ Staging Gateway $$STAGING_GW_NAME URL: https://$$GW_URL"; \
		echo ""; \
	done
	@echo "🎉 API Gateway deployment completed!"

clean: ## Clean generated files
	@echo "🧹 Cleaning generated files..."
	@rm -rf gateway/*-swagger.yaml
	@rm -rf node_modules
	@rm -rf postman-collections
	@echo "✅ Clean completed"

# Check prerequisites
check-prereqs: ## Check if all required tools are installed
	@echo "🔍 Checking prerequisites..."
	@command -v npm >/dev/null 2>&1 || (echo "❌ npm not found" && exit 1)
	@command -v gcloud >/dev/null 2>&1 || (echo "❌ gcloud CLI not found" && exit 1)
	@command -v jq >/dev/null 2>&1 || (echo "❌ jq not found" && exit 1)
	@echo "✅ All prerequisites met"

# Test gateway endpoints
test-gateway: ## Test deployed gateway endpoints
	@echo "🧪 Testing gateway endpoints..."
	@for gw in $$(jq -r '.gateways | keys[]' $(CONFIG_PATH)); do \
		STAGING_GW_NAME="$${gw}-staging-gateway"; \
		GW_URL=$$(gcloud api-gateway gateways describe "$$STAGING_GW_NAME" --location="$(LOCATION)" --project="$(PROJECT_ID)" --format="value(defaultHostname)" 2>/dev/null); \
		if [ -n "$$GW_URL" ]; then \
			echo "🌐 Testing $$gw gateway: https://$$GW_URL"; \
			curl -s -o /dev/null -w "Status: %{http_code}, Time: %{time_total}s\n" "https://$$GW_URL/api/v1/health" || echo "❌ Health check failed"; \
		else \
			echo "❌ Gateway $$STAGING_GW_NAME not found"; \
		fi; \
	done

# Show gateway status
status: ## Show current gateway status
	@echo "📊 Gateway Status"
	@echo "================="
	@for gw in $$(jq -r '.gateways | keys[]' $(CONFIG_PATH)); do \
		STAGING_GW_NAME="$${gw}-staging-gateway"; \
		echo "🔍 Checking $$STAGING_GW_NAME..."; \
		if gcloud api-gateway gateways describe "$$STAGING_GW_NAME" --location="$(LOCATION)" --project="$(PROJECT_ID)" >/dev/null 2>&1; then \
			GW_URL=$$(gcloud api-gateway gateways describe "$$STAGING_GW_NAME" --location="$(LOCATION)" --project="$(PROJECT_ID)" --format="value(defaultHostname)"); \
			echo "✅ $$STAGING_GW_NAME: https://$$GW_URL"; \
		else \
			echo "❌ $$STAGING_GW_NAME: Not deployed"; \
		fi; \
	done

# Generate Flutter API client
flutter-client: ## Generate Flutter API client for corneroom
	@echo "📱 Generating Flutter API client for corneroom..."
	@if [ ! -f gateway/app-swagger.yaml ]; then \
		echo "❌ app-swagger.yaml not found. Run 'make build-swagger' first."; \
		exit 1; \
	fi
	@if ! command -v npm >/dev/null 2>&1; then \
		echo "❌ npm not found. Please install Node.js and npm."; \
		exit 1; \
	fi
	@echo "📦 Installing OpenAPI Generator..."
	@npm install --save-dev @openapitools/openapi-generator-cli --cache .npm-cache
	@echo "🧹 Cleaning previous generation..."
	@rm -rf libs/flutter
	@echo "🚀 Generating Flutter client..."
	@npx @openapitools/openapi-generator-cli generate \
		-i gateway/app-swagger.yaml \
		-g dart \
		-o libs/flutter \
		--package-name=corneroom_api \
		--additional-properties=pubVersion=1.0.0,nullableFields=true,enumUnknownDefaultCase=true
	@echo "📖 Creating README..."
	@echo "# Corneroom API Client\n\nAuto-generated Flutter/Dart API client.\n\n## Usage\n\n\`\`\`dart\nimport 'package:corneroom_api/api.dart';\n\nfinal apiClient = ApiClient(basePath: 'https://your-gateway.com/api/v1');\nfinal bookingApi = BookingApi(apiClient);\n\`\`\`\n\nGenerated: $(shell date)" > libs/flutter/README.md
	@echo "✅ Flutter API client generated successfully!"
	@echo "📁 Output: libs/flutter/"

# Sync API specs from backend services
sync: ## Sync API specs from backend services to services/ directory
	@echo "🔄 Syncing API specs from backend services..."
	@echo "📋 Copying booking-service API spec..."
	@cp ../../../backend/booking-service/docs/api.yaml services/booking-service.yaml
	@echo "📋 Copying chat-service API spec..."
	@cp ../../../backend/chat-service/docs/api.yaml services/chat-service.yaml
	@echo "📋 Copying community-service API spec..."
	@cp ../../../backend/community-service/docs/api.yaml services/community-service.yaml
	@echo "📋 Copying dashboard-service API spec..."
	@cp ../../../backend/dashboard-service/docs/api.yaml services/dashboard-service.yaml
	@echo "📋 Copying document-service API spec..."
	@cp ../../../backend/document-service/docs/api.yaml services/document-service.yaml
	@echo "📋 Copying listing-service API spec..."
	@cp ../../../backend/listing-service/docs/api.yaml services/listing-service.yaml
	@echo "📋 Copying payment-service API spec..."
	@cp ../../../backend/payment-service/docs/api.yaml services/payment-service.yaml
	@echo "📋 Copying review-service API spec..."
	@cp ../../../backend/review-service/docs/api.yaml services/review-service.yaml
	@echo "📋 Copying user-service API spec..."
	@cp ../../../backend/user-service/docs/api.yaml services/user-service.yaml
	@echo "📋 Copying verification-service API spec..."
	@cp ../../../backend/verification-service/docs/api.yaml services/verification-service.yaml
	@echo "📋 Copying wishlist-service API spec..."
	@cp ../../../backend/wishlist-service/docs/api.yaml services/wishlist-service.yaml
	@echo "✅ API specs sync completed!"
auth: ## Authenticate with Google Cloud using Application Default Credentials
	@echo "🔐 Setting up Google Cloud Application Default Credentials..."
	@gcloud auth application-default login --project="$(PROJECT_ID)"
	@echo "✅ Authentication complete!"