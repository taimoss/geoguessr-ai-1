"""
Initial TinyViT-based training script for the GeoGuessr automation project.

The script expects a folder structure like:
data/images/
├── Germany/
│   ├── round1_2025.png
│   └── ...
└── Brazil/
    └── ...

Usage:
    python -m ml.train --data-dir data/images --epochs 10
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
    transform = transforms.Compose(
        [
            transforms.Resize((image_size, image_size)),
            transforms.RandomHorizontalFlip(),
            transforms.RandomApply(
                [
                    transforms.ColorJitter(
                        brightness=0.2,
                        contrast=0.2,
                        saturation=0.2,
                        hue=0.05,
                    )
                ],
                p=0.5,
            ),
            transforms.ToTensor(),
        ]
    )

    dataset = datasets.ImageFolder(root=str(data_dir), transform=transform)
    val_size = max(1, int(len(dataset) * val_split))
    train_size = len(dataset) - val_size
    train_ds, val_ds = random_split(dataset, [train_size, val_size])

    train_loader = DataLoader(
        train_ds,
        batch_size=batch_size,
        shuffle=True,
        num_workers=num_workers,
        pin_memory=True,
    )
    val_loader = DataLoader(
        val_ds,
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
        pin_memory=True,
    )
    return train_loader, val_loader, dataset.classes


def train_one_epoch(model, dataloader, criterion, optimizer, device):
    model.train()
    running_loss = 0.0
    correct = 0
    total = 0

    for images, labels in tqdm(dataloader, desc="Train", leave=False):
        images, labels = images.to(device), labels.to(device)
        optimizer.zero_grad(set_to_none=True)
        outputs = model(images)
        loss = criterion(outputs, labels)
        loss.backward()
        optimizer.step()

        running_loss += loss.item() * images.size(0)
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
        images, labels = images.to(device), labels.to(device)
        outputs = model(images)
        loss = criterion(outputs, labels)

        running_loss += loss.item() * images.size(0)
        _, preds = outputs.max(1)
        correct += preds.eq(labels).sum().item()
        total += labels.size(0)

    return running_loss / total, correct / total


def persist_artifacts(model, class_names, output_dir: Path, epoch: int, acc: float):
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output_dir / f"tinyvit_country_epoch{epoch}_acc{acc:.3f}.pt"
    torch.save(model.state_dict(), checkpoint_path)

    mapping_path = output_dir / "classes.json"
    with open(mapping_path, "w", encoding="utf-8") as fh:
        json.dump(class_names, fh, indent=2)

    print(f"[+] Saved checkpoint to {checkpoint_path}")
    print(f"[+] Saved class mapping to {mapping_path}")


def main():
    parser = argparse.ArgumentParser(description="Train TinyViT on collected GeoGuessr images.")
    parser.add_argument("--data-dir", default="data/images", type=str, help="Path to image dataset.")
    parser.add_argument("--image-size", default=224, type=int)
    parser.add_argument("--batch-size", default=16, type=int)
    parser.add_argument("--epochs", default=5, type=int)
    parser.add_argument("--lr", default=5e-4, type=float)
    parser.add_argument("--val-split", default=0.1, type=float)
    parser.add_argument("--num-workers", default=4, type=int)
    parser.add_argument("--output-dir", default="artifacts/checkpoints", type=str)
    parser.add_argument("--seed", default=42, type=int)
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

    model = timm.create_model(
        "tiny_vit_21m_224",
        pretrained=True,
        num_classes=len(class_names),
    ).to(device)

    criterion = nn.CrossEntropyLoss()
    optimizer = AdamW(model.parameters(), lr=args.lr)
    scheduler = CosineAnnealingLR(optimizer, T_max=args.epochs)

    best_acc = 0.0
    output_dir = Path(args.output_dir)

    for epoch in range(1, args.epochs + 1):
        print(f"\nEpoch {epoch}/{args.epochs}")
        train_loss, train_acc = train_one_epoch(model, train_loader, criterion, optimizer, device)
        val_loss, val_acc = evaluate(model, val_loader, criterion, device)
        scheduler.step()

        print(
            f"Train Loss: {train_loss:.4f} | Train Acc: {train_acc:.4f} | "
            f"Val Loss: {val_loss:.4f} | Val Acc: {val_acc:.4f}"
        )

        if val_acc > best_acc:
            best_acc = val_acc
            persist_artifacts(model, class_names, output_dir, epoch, val_acc)

    print(f"[✓] Training complete. Best Val Acc: {best_acc:.4f}")


if __name__ == "__main__":
    main()
