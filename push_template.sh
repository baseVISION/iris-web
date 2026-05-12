#!/bin/bash

# Define the local template path
LOCAL_TEMPLATE="local_dev/test_template.docx"

# Container name
CONTAINER_NAME="bv-iriswebapp-app"

# Find the newest docx file in the user_templates directory inside the container
LATEST_TEMPLATE_FILE=$(podman exec -it $CONTAINER_NAME sh -c 'ls -t /home/iris/user_templates/*.docx | head -n 1' | tr -d '\r')

if [ -z "$LATEST_TEMPLATE_FILE" ]; then
    echo "No existing template found in the pod to overwrite. Please upload a template via UI first."
    exit 1
fi

echo "Overwriting $LATEST_TEMPLATE_FILE in pod $CONTAINER_NAME..."
podman cp "$LOCAL_TEMPLATE" "$CONTAINER_NAME:$LATEST_TEMPLATE_FILE"
echo "Template updated successfully!"
