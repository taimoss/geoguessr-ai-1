"""
ConvNeXt-Tiny based training script for GeoGuessr automation project.
Optimized for 180-degree Street View panoramic images on RTX 3060 Ti (8GB VRAM).

The script expects a folder structure like:
data/images/
├── Germany/
│   ├── round1_2025.png
│   └── ...
└── Brazil/
    └── ...

Usage:
    python -m ml.train --data-dir data/images --epochs 10
    python -m ml.train --data-dir data/images --epochs 20 --image-size 384 --batch-size 8
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import torch
import timm
from torch import nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR
from torch.utils.data import DataLoader, random_split
from torch.cuda.amp import GradScaler, autocast
from torchvision import datasets, transforms
from tqdm import tqdm


def set_seed(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def build_dataloaders(
    data_dir: Path,
    image_size: int,
    batch_size: int,
    val_split: float,
    num_workers: int,
):
    # Enhanced transforms for 180-degree panoramic street view images
    train_transform = transforms.Compose(
        [
            transforms.Resize((image_size, image_size)),
            transforms.RandomHorizontalFlip(p=0.5),
            # Random rotation for varied perspectives
            transforms.RandomRotation(degrees=5),
            # Random crop and resize for scale invariance
            transforms.RandomResizedCrop(
                image_size,
                scale=(0.85, 1.0),
                ratio=(0.9, 1.1),
            ),
            # Color augmentation for different lighting/weather
            transforms.RandomApply(
                [
                    transforms.ColorJitter(
                        brightness=0.3,
                        contrast=0.3,
                        saturation=0.3,
                        hue=0.1,
                    )
                ],
                p=0.6,
            ),
            # Random grayscale to handle B&W images
            transforms.RandomGrayscale(p=0.05),
            # Gaussian blur for varying image quality
            transforms.RandomApply(
                [transforms.GaussianBlur(kernel_size=3)],
                p=0.1,
            ),
            transforms.ToTensor(),
            # ImageNet normalization (required for pretrained models)
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ]
    )

    val_transform = transforms.Compose(
        [
            transforms.Resize((image_size, image_size)),
            transforms.ToTensor(),
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ]
    )

    # Load full dataset with training transforms
    full_dataset = datasets.ImageFolder(root=str(data_dir), transform=train_transform)

    # Split into train and validation
    val_size = max(1, int(len(full_dataset) * val_split))
    train_size = len(full_dataset) - val_size
    train_ds, val_ds = random_split(full_dataset, [train_size, val_size])

    # Apply validation transforms to validation set
    val_ds.dataset.transform = val_transform

    train_loader = DataLoader(
        train_ds,
        batch_size=batch_size,
        shuffle=True,
        num_workers=num_workers,
        pin_memory=True,
        drop_last=True,  # Avoid small batches for stable training
    )
    val_loader = DataLoader(
        val_ds,
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
        pin_memory=True,
    )
    return train_loader, val_loader, full_dataset.classes


def train_one_epoch(model, dataloader, criterion, optimizer, device, scaler, accumulation_steps=1):
    model.train()
    running_loss = 0.0
    correct = 0
    total = 0

    optimizer.zero_grad(set_to_none=True)

    for i, (images, labels) in enumerate(tqdm(dataloader, desc="Train", leave=False)):
        images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)

        # Mixed precision forward pass
        with autocast():
            outputs = model(images)
            loss = criterion(outputs, labels) / accumulation_steps

        # Scaled backward pass
        scaler.scale(loss).backward()

        # Gradient accumulation
        if (i + 1) % accumulation_steps == 0:
            scaler.step(optimizer)
            scaler.update()
            optimizer.zero_grad(set_to_none=True)

        running_loss += loss.item() * accumulation_steps * images.size(0)
        _, preds = outputs.max(1)
        correct += preds.eq(labels).sum().item()
        total += labels.size(0)

    return running_loss / total, correct / total


@torch.no_grad()
def evaluate(model, dataloader, criterion, device):
    model.eval()
    running_loss = 0.0
    correct = 0
    total = 0

    for images, labels in tqdm(dataloader, desc="Val", leave=False):
        images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)

        with autocast():
            outputs = model(images)
            loss = criterion(outputs, labels)

        running_loss += loss.item() * images.size(0)
        _, preds = outputs.max(1)
        correct += preds.eq(labels).sum().item()
        total += labels.size(0)

    return running_loss / total, correct / total


def persist_artifacts(model, class_names, output_dir: Path, epoch: int, acc: float, model_name: str):
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output_dir / f"{model_name}_country_epoch{epoch}_acc{acc:.3f}.pt"
    torch.save(model.state_dict(), checkpoint_path)

    mapping_path = output_dir / "classes.json"
    with open(mapping_path, "w", encoding="utf-8") as fh:
        json.dump(class_names, fh, indent=2)

    print(f"[+] Saved checkpoint to {checkpoint_path}")
    print(f"[+] Saved class mapping to {mapping_path}")


def main():
    parser = argparse.ArgumentParser(description="Train ConvNeXt-Tiny on collected GeoGuessr images.")
    parser.add_argument("--data-dir", default="data/images", type=str, help="Path to image dataset.")
    parser.add_argument("--image-size", default=384, type=int, help="Input image size (384 recommended for panoramas)")
    parser.add_argument("--batch-size", default=8, type=int, help="Batch size (8 for 8GB VRAM with 384px)")
    parser.add_argument("--epochs", default=10, type=int)
    parser.add_argument("--lr", default=3e-4, type=float, help="Learning rate")
    parser.add_argument("--weight-decay", default=0.05, type=float, help="Weight decay for AdamW")
    parser.add_argument("--val-split", default=0.1, type=float)
    parser.add_argument("--num-workers", default=4, type=int)
    parser.add_argument("--output-dir", default="artifacts/checkpoints", type=str)
    parser.add_argument("--seed", default=42, type=int)
    parser.add_argument("--accumulation-steps", default=2, type=int, help="Gradient accumulation steps")
    parser.add_argument(
        "--model",
        default="convnext_tiny",
        type=str,
        choices=["convnext_tiny", "convnext_small", "efficientnetv2_s", "efficientnetv2_m"],
        help="Model architecture"
    )
    args = parser.parse_args()

    set_seed(args.seed)

    data_dir = Path(args.data_dir)
    if not data_dir.exists():
        raise FileNotFoundError(f"Dataset folder {data_dir} does not exist.")

    train_loader, val_loader, class_names = build_dataloaders(
        data_dir=data_dir,
        image_size=args.image_size,
        batch_size=args.batch_size,
        val_split=args.val_split,
        num_workers=args.num_workers,
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[i] Training on {len(class_names)} countries using device: {device}")
    print(f"[i] Model: {args.model} | Image size: {args.image_size}px | Batch: {args.batch_size}")
    print(f"[i] Effective batch size: {args.batch_size * args.accumulation_steps}")

    # Create model
    model = timm.create_model(
        args.model,
        pretrained=True,
        num_classes=len(class_names),
        drop_path_rate=0.1,  # Stochastic depth for regularization
    ).to(device)

    # Print model info
    num_params = sum(p.numel() for p in model.parameters()) / 1e6
    print(f"[i] Model parameters: {num_params:.1f}M")

    criterion = nn.CrossEntropyLoss(label_smoothing=0.1)  # Label smoothing for better generalization
    optimizer = AdamW(
        model.parameters(),
        lr=args.lr,
        weight_decay=args.weight_decay,
        betas=(0.9, 0.999),
    )
    scheduler = CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=1e-6)

    # Mixed precision scaler for memory efficiency
    scaler = GradScaler()

    best_acc = 0.0
    output_dir = Path(args.output_dir)

    for epoch in range(1, args.epochs + 1):
        print(f"\nEpoch {epoch}/{args.epochs}")
        train_loss, train_acc = train_one_epoch(
            model, train_loader, criterion, optimizer, device, scaler, args.accumulation_steps
        )
        val_loss, val_acc = evaluate(model, val_loader, criterion, device)
        scheduler.step()

        current_lr = scheduler.get_last_lr()[0]
        print(
            f"Train Loss: {train_loss:.4f} | Train Acc: {train_acc:.4f} | "
            f"Val Loss: {val_loss:.4f} | Val Acc: {val_acc:.4f} | LR: {current_lr:.6f}"
        )

        if val_acc > best_acc:
            best_acc = val_acc
            persist_artifacts(model, class_names, output_dir, epoch, val_acc, args.model)

    print(f"\n[OK] Training complete. Best Val Acc: {best_acc:.4f}")


if __name__ == "__main__":
    main()
